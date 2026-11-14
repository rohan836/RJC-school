require("dotenv").config({ quiet: true });
const express = require("express");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const QRCode = require("qrcode");
const { parse } = require("csv-parse/sync");
const { rateLimit } = require("express-rate-limit");
const { openDatabase, hashPassword, checkPassword } = require("./db");
const {
  esc,
  clean,
  renderCertificate,
  pdf,
  normalizeUdise,
} = require("./certificate");
const { rankStudents } = require("./student-search");
const { createParentAuth } = require("./parent-auth");
const { createOtpTransport } = require("./whatsapp");
const dataDir = process.env.KIOSK_DATA_DIR || __dirname;
const port = Number(process.env.PORT || 3000);
const db = openDatabase(dataDir);
const interfaces = Object.values(os.networkInterfaces())
  .flat()
  .filter((i) => i.family === "IPv4" && !i.internal);
const preferred = interfaces.find((i) =>
  /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(i.address),
);
const lanIp =
  process.env.LAN_IP || (preferred || interfaces[0])?.address || "localhost";
const normalizePortalUrl = (value) => {
  try {
    const u = new URL(String(value || "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
};
const publicPortalEnv = process.env.PUBLIC_PORTAL_URL
  ? normalizePortalUrl(process.env.PUBLIC_PORTAL_URL)
  : null;
if (process.env.PUBLIC_PORTAL_URL && !publicPortalEnv)
  throw Error("Invalid PUBLIC_PORTAL_URL");
// Base URL used inside the phone QR: Admin setting → .env → auto-detected
// cloudflared tunnel (public-url file) → LAN fallback.
function portalUrl() {
  try {
    const fromAdmin = normalizePortalUrl(settings().public_url || "");
    if (fromAdmin) return fromAdmin;
  } catch {}
  if (publicPortalEnv) return publicPortalEnv;
  try {
    const auto = normalizePortalUrl(
      fs.readFileSync(path.join(dataDir, "public-url"), "utf8"),
    );
    if (auto) return auto;
  } catch {}
  return `http://${lanIp}:${port}`;
}
const portalHostname = () => {
  try {
    return new URL(portalUrl()).hostname;
  } catch {
    return null;
  }
};
const local = (req) =>
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
const isHostedPreviewHost = (hostname) =>
  /\.run\.app$/i.test(String(hostname || ""));
const canAccessLocalCounter = (req) =>
  local(req) || isHostedPreviewHost(req.hostname);
const tokens = new Map();
const studentRefs = new Map();
const STUDENT_REF_TTL = 15 * 60 * 1000;
function createStudentRef(grNumber) {
  const now = Date.now();
  for (const [ref, entry] of studentRefs)
    if (entry.expiresAt <= now) studentRefs.delete(ref);
  while (studentRefs.size >= 5000)
    studentRefs.delete(studentRefs.keys().next().value);
  const ref = crypto.randomBytes(24).toString("base64url");
  studentRefs.set(ref, { grNumber, expiresAt: now + STUDENT_REF_TTL });
  return ref;
}
function resolveStudentRef(value) {
  const ref = text(value, "student selection", 64);
  const entry = studentRefs.get(ref);
  if (!entry || entry.expiresAt <= Date.now()) {
    studentRefs.delete(ref);
    fail("Your student selection expired. Search for the student again.", 410);
  }
  return entry.grNumber;
}
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
const allowedHosts = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  lanIp,
  ...interfaces.map((i) => i.address),
]);
for (const envUrl of [process.env.APP_URL, process.env.SHARED_APP_URL]) {
  const normalized = normalizePortalUrl(envUrl);
  if (normalized) allowedHosts.add(new URL(normalized).hostname);
}
if (process.env.PUBLIC_WEBHOOK_URL) {
  try {
    allowedHosts.add(new URL(process.env.PUBLIC_WEBHOOK_URL).hostname);
  } catch {
    throw Error("Invalid PUBLIC_WEBHOOK_URL");
  }
}
// Routes that are safe to expose through the public tunnel host.
// Everything else (/admin, /api/admin/*, /api/campus-code, ...) stays local.
const isPublicPortalAllowed = (req) => {
  const p = req.path;
  if (
    req.method === "GET" &&
    (p === "/" || p === "/index.html" || p === "/favicon.ico")
  )
    return true;
  if (req.method === "GET" && p.startsWith("/fonts/")) return true;
  if (req.method === "GET" && p === "/api/public-config") return true;
  if (
    req.method === "POST" &&
    (p === "/api/search-student" || p === "/api/generate-document" || p.startsWith("/api/parent/"))
  )
    return true;
  if (req.method === "GET" && p === "/api/parent/students") return true;
  if (req.method === "GET" && /^\/api\/documents\/[^/]+\/pdf$/.test(p))
    return true;
  if (req.method === "GET" && /^\/verify\/[^/]+$/.test(p)) return true;
  return false;
};
app.use((req, res, next) => {
  if (
    process.env.PUBLIC_WEBHOOK_URL &&
    req.hostname === new URL(process.env.PUBLIC_WEBHOOK_URL).hostname &&
    req.path !== "/webhook"
  )
    return res
      .status(403)
      .json({ error: "Public access is restricted to the WhatsApp webhook." });
  const portalHost = portalHostname();
  const isLocalPortal =
    !portalHost ||
    portalHost === lanIp ||
    ["localhost", "127.0.0.1", "[::1]"].includes(portalHost);
  if (portalHost && req.hostname === portalHost && !isLocalPortal) {
    if (!isPublicPortalAllowed(req))
      return res.status(403).json({
        error: "This link provides access to the parent portal only.",
      });
  } else if (
    !allowedHosts.has(req.hostname) &&
    !isHostedPreviewHost(req.hostname)
  )
    return res.status(403).json({ error: "Invalid host" });
  const forwardedHost = req.headers["x-forwarded-host"];
  if (
    req.headers.origin &&
    req.headers.origin !== `http://${req.headers.host}` &&
    req.headers.origin !== `https://${req.headers.host}` &&
    (!forwardedHost ||
      (req.headers.origin !== `http://${forwardedHost}` &&
        req.headers.origin !== `https://${forwardedHost}`))
  )
    return res.status(403).json({ error: "Cross-origin requests are denied" });
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-src 'self' about:; connect-src 'self'; base-uri 'none'; form-action 'self'",
  });
  next();
});
app.use(
  express.json({
    limit: "8mb",
    verify: (req, res, buf) => {
      if (req.path === "/webhook") req.rawBody = buf;
    },
  }),
);
app.use(
  "/api",
  rateLimit({
    windowMs: 60000,
    limit: 300,
    legacyHeaders: false,
    standardHeaders: "draft-8",
    message: { error: "Too many requests. Please wait a minute." },
  }),
);
app.use("/api", (req, res, next) => {
  if (
    ["POST", "PUT", "PATCH"].includes(req.method) &&
    (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
  )
    return res.status(400).json({ error: "A JSON object is required" });
  next();
});
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};
function text(v, name, max = 200, required = true) {
  if (typeof v !== "string" || v.length > max || (required && !v.trim()))
    fail(`Invalid ${name}`);
  return v.trim();
}
const settings = () =>
  db.prepare("SELECT * FROM school_settings WHERE id=1").get();
const otpTransport = createOtpTransport();
const parentAuth = createParentAuth({ db, sendOtp: otpTransport.sendOtp, otpConfigured: otpTransport.configured });
const parentToken = req => String(req.headers["x-parent-session"] || "");
function requireParent(req, res, next) {
  req.parentSession = parentAuth.getSession(parentToken(req));
  if (!req.parentSession) return res.status(401).json({ error: "Verification required." });
  next();
}
const safeSettings = () => {
  const { wifi_ssid, wifi_password, ...s } = settings();
  return s;
};
function requireAdmin(req, res, next) {
  const t = req.headers["x-admin-token"];
  if (!t || !tokens.has(t) || tokens.get(t) < Date.now()) {
    tokens.delete(t);
    return res
      .status(401)
      .json({ error: "Admin session expired. Please sign in." });
  }
  next();
}
let campus = {
  code: String(crypto.randomInt(1000, 10000)),
  expiresAt: Date.now() + 60000,
};
let qrCache;
function rotate() {
  campus = {
    code: String(
      ((+campus.code - 1000 + crypto.randomInt(1, 9000)) % 9000) + 1000,
    ),
    expiresAt: Date.now() + 60000,
  };
  qrCache = null;
}
const ticker = setInterval(() => {
  if (Date.now() >= campus.expiresAt) rotate();
  for (const [t, e] of tokens) if (e < Date.now()) tokens.delete(t);
}, 1000);
ticker.unref();
// Automatic backup: if today's snapshot is missing, create it 10s after startup
// (and every 24h afterwards). Keeps the 14 most recent auto-YYYY-MM-DD.db files.
const autoBackupName = (date) => {
  const y = date.getFullYear(),
    m = String(date.getMonth() + 1).padStart(2, "0"),
    d = String(date.getDate()).padStart(2, "0");
  return `auto-${y}-${m}-${d}.db`;
};
async function autoBackup() {
  try {
    const dir = path.join(dataDir, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, autoBackupName(new Date()));
    if (!fs.existsSync(dest)) {
      await db.backup(dest);
      console.log("Automatic backup saved: " + dest);
    }
    const autos = fs
      .readdirSync(dir)
      .filter((f) => /^auto-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort();
    for (const f of autos.slice(0, Math.max(0, autos.length - 14)))
      fs.unlinkSync(path.join(dir, f));
  } catch (e) {
    console.error("Automatic backup failed: " + (e?.message || e));
  }
}
const backupTimer = setInterval(autoBackup, 24 * 60 * 60 * 1000);
backupTimer.unref();
const startupBackup = setTimeout(autoBackup, 10000);
startupBackup.unref();
const qr = (t) =>
  QRCode.toDataURL(t, { width: 280, margin: 2, errorCorrectionLevel: "M" });
const wifiEscape = (s) => String(s || "").replace(/[\\;,:\"]/g, "\\$&");
app.get("/api/health", (req, res) =>
  res.json({
    ok: true,
    appId: "rjc-school-portal",
    projectKey: crypto.createHash("sha256").update(path.resolve(__dirname).toLowerCase()).digest("hex"),
    pid: process.pid,
    journalMode: db.pragma("journal_mode", { simple: true }),
    synchronous: db.pragma("synchronous", { simple: true }),
  }),
);
app.get("/api/campus-code", async (req, res) => {
  if (!canAccessLocalCounter(req))
    return res
      .status(403)
      .json({ error: "Campus code is shown on the school monitor only." });
  if (Date.now() >= campus.expiresAt) rotate();
  if (!qrCache) {
    const snapshot = { ...campus };
    const s = settings();
    const url = `${portalUrl()}/`;
    const wifi = s.wifi_ssid
      ? `WIFI:T:WPA;S:${wifiEscape(s.wifi_ssid)};P:${wifiEscape(s.wifi_password)};;`
      : null;
    const data = {
      ...snapshot,
      lanIp,
      portalUrl: portalUrl(),
      portalLink: url,
      portalQr: await qr(url),
      wifiQr: wifi ? await qr(wifi) : null,
      wifiSsid: s.wifi_ssid || "",
    };
    if (snapshot.code === campus.code) qrCache = data;
    else
      return res.status(409).json({ error: "Code changed; refresh display." });
  }
  res.json({
    ...qrCache,
    secondsLeft: Math.max(0, Math.ceil((campus.expiresAt - Date.now()) / 1000)),
    serverTime: Date.now(),
  });
});
app.get("/api/public-config", (req, res) => res.json({
  schoolName: settings().school_name, schoolSubtitle: settings().school_subtitle,
  schoolTagline: String(settings().school_subtitle || "").split("•")[0].trim(),
  portalUrl: portalUrl(), otpConfigured: otpTransport.configured(),
}));
const parentRate = rateLimit({ windowMs: 900000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: "Please wait before trying again." } });
// Search fires while a parent types. Keep it separate from authentication attempts,
// so autocomplete cannot exhaust the shared OTP/family-check allowance.
const parentSearchRate = rateLimit({ windowMs: 60000, limit: 300, standardHeaders: true, legacyHeaders: false, message: { error: "Too many searches. Please wait a moment and try again." } });
app.post("/api/parent/find", parentSearchRate, (req, res) => {
  const query = text(req.body.query || "", "search query", 100, false);
  const rows = query.length >= 2 ? rankStudents(db.prepare("SELECT * FROM students WHERE status='ACTIVE'").all(), query) : [];
  res.json({ students: rows.map(row => ({ studentRef: createStudentRef(row.gr_number), label: row.full_name, class_name: row.class_name, division: row.division })) });
});
app.post("/api/parent/start", parentRate, async (req, res) => {
  if (req.body.studentRef) {
    const gr = resolveStudentRef(req.body.studentRef);
    const row = db.prepare("SELECT parent_phone FROM students WHERE gr_number=? AND status='ACTIVE'").get(gr);
    if (!row) fail("Selection expired. Search again.", 410);
    return res.json(await parentAuth.start(row.parent_phone, req.body.lang, gr));
  }
  res.json(await parentAuth.start(req.body.phone, req.body.lang));
});
app.post("/api/parent/otp", parentRate, (req, res) => res.json(parentAuth.verifyOtp(req.body.challengeId, req.body.code)));
app.post("/api/parent/family", parentRate, (req, res) => res.json(parentAuth.verifyFamily(req.body.challengeId, req.body.birthYear, req.body.identifierType, req.body.identifier)));
app.post("/api/parent/guardian", parentRate, (req, res) => res.json(parentAuth.redeem(req.body.approval)));
app.post("/api/parent/done", (req, res) => { parentAuth.finish(parentToken(req)); res.sendStatus(204); });
app.get("/api/parent/students", requireParent, (req, res) => {
  const students = [...req.parentSession.refs].map(([studentRef, gr]) => ({
    studentRef,
    ...db.prepare("SELECT gr_number,full_name,father_name,mother_name,class_name,division,dob,roll_no,academic_year,blood_group,house,apaar_id,parent_phone,emergency_phone,bus_route,address,remarks,photo_data FROM students WHERE gr_number=? AND status='ACTIVE'").get(gr),
  }));
  res.json({ students, templates: db.prepare("SELECT id,title_mr,title_hi,title_en FROM document_templates WHERE is_active=1").all() });
});
app.post("/api/search-student", requireParent, (req, res) => {
  const rows = [...req.parentSession.refs].map(([studentRef, gr]) => ({ studentRef, ...db.prepare("SELECT gr_number,full_name,father_name,class_name,division,parent_phone FROM students WHERE gr_number=? AND status='ACTIVE'").get(gr) }));
  const matches = req.body.query ? rankStudents(rows, String(req.body.query).slice(0, 100)) : rows;
  res.json({ students: matches.map(({ studentRef, full_name, class_name, division }) => ({ studentRef, full_name, class_name, division })) });
});
function canonicalDate(value) {
  const raw = String(value || "").trim();
  let year, month, day;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match) [, year, month, day] = match;
  else {
    match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
    if (!match) return "";
    [, day, month, year] = match;
  }
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  )
    return "";
  return `${year}-${month}-${day}`;
}
function checkFamily(b, student) {
  const now = Date.now();
  let a = db
    .prepare("SELECT * FROM verification_attempts WHERE gr_number=?")
    .get(student.gr_number);
  if (a?.locked_until > now)
    fail(
      "Verification locked for 15 minutes after three incorrect attempts.",
      423,
    );
  if (a?.locked_until && a.locked_until <= now) {
    db.prepare("DELETE FROM verification_attempts WHERE gr_number=?").run(
      student.gr_number,
    );
    a = null;
  }
  let valid;
  if (b.verificationMode === "backup") {
    const registeredPhone = String(student.parent_phone || "").replace(/\D/g, "");
    const storedDob = canonicalDate(student.dob);
    const suppliedDob = canonicalDate(b.dateOfBirth);
    valid =
      Boolean(storedDob && suppliedDob && suppliedDob === storedDob) &&
      /^\d{4}$/.test(String(b.registeredPhoneLast4 || "")) &&
      String(b.registeredPhoneLast4) === registeredPhone.slice(-4);
  } else valid = String(b.birthYear || "") === student.birth_year;
  if (b.isGuardian === true)
    valid = valid && /^\d{10}$/.test(String(b.guardianPhone || ""));
  if (!valid) {
    const n = (a?.failures || 0) + 1;
    db.prepare(
      "INSERT INTO verification_attempts(gr_number,failures,locked_until) VALUES(?,?,?) ON CONFLICT(gr_number) DO UPDATE SET failures=excluded.failures,locked_until=excluded.locked_until",
    ).run(student.gr_number, n, n >= 3 ? now + 900000 : 0);
    fail(
      n >= 3
        ? "Verification locked for 15 minutes. Please contact school staff."
        : `Verification did not match school records. ${3 - n} attempts remaining.`,
      n >= 3 ? 423 : 401,
    );
  }
  db.prepare("DELETE FROM verification_attempts WHERE gr_number=?").run(
    student.gr_number,
  );
}
function issue(b, session, sessionToken) {
  if (!session || session.serial) fail("Verification required.", 401);
  if (Date.now() >= campus.expiresAt || String(b.campusCode || "") !== campus.code)
    fail("Campus code is invalid or expired. Check the school monitor.", 403);
  const gr = session.refs.get(String(b.studentRef || ""));
  if (!gr) fail("Verification required.", 403);
  const student = db.prepare("SELECT * FROM students WHERE gr_number=? AND status='ACTIVE'").get(gr);
  if (!student) fail("Verification required.", 403);
  const tpl = db.prepare("SELECT * FROM document_templates WHERE id=? AND is_active=1").get(Number(b.templateId) || 0);
  if (!tpl) fail("Document template is unavailable.", 404);
  let guardianPhone = "";
  if (session.method === "staff") guardianPhone = session.guardianPhone;
  else if (b.isGuardian === true) {
    if (session.method !== "otp" || !/^\d{10}$/.test(String(b.guardianPhone || ""))) fail("Guardian approval is required.", 403);
    guardianPhone = String(b.guardianPhone);
  }
  const year = new Intl.DateTimeFormat("en", {
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(new Date());
  const prefix = `RJC-${year}-`;
  if (
    db
      .prepare("SELECT count(*) AS n FROM issued_logs WHERE serial_no LIKE ?")
      .get(prefix + "%").n >= 90000
  )
    fail("Annual serial number capacity reached.", 409);
  let serialNo;
  do {
    serialNo = prefix + crypto.randomInt(10000, 100000);
  } while (
    db.prepare("SELECT 1 FROM issued_logs WHERE serial_no=?").get(serialNo)
  );
  const issuedAt = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const lang = ["mr", "hi", "en"].includes(b.lang) ? b.lang : "en";
  const body =
    lang === "en" ? tpl.body_html : tpl["body_" + lang] || tpl.body_html;
  const vals = {
    student_name: student.full_name,
    father_name: student.father_name,
    mother_name: student.mother_name || "",
    class_name: student.class_name,
    division: student.division,
    gr_number: student.gr_number,
    roll_no: student.roll_no || "",
    academic_year: student.academic_year || "",
    blood_group: student.blood_group || "",
    house: student.house || "",
    apaar_id: student.apaar_id || "",
    address: student.address || "",
    dob: student.dob,
    issue_date: issuedAt,
  };
  const downloadToken = crypto.randomBytes(32).toString("hex");
  const cert = {
    serialNo,
    issuedAt,
    docTitle: tpl["title_" + lang],
    bodyHtml: clean(body).replace(/{{(\w+)}}/g, (_, key) =>
      esc(vals[key] || ""),
    ),
    sigPos: tpl.sig_pos,
    stampPos: tpl.stamp_pos,
    lang,
    settings: safeSettings(),
    student: {
      full_name: student.full_name,
      gr_number: student.gr_number,
      class_name: student.class_name,
      division: student.division,
    },
    verificationUrl: `${portalUrl()}/verify/${serialNo}`,
  };
  db.transaction(() => {
    db.prepare(
      "INSERT INTO issued_logs(serial_no,gr_number,student_name,doc_title,verified_phone,is_guardian,issued_at,certificate_json,download_hash) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      serialNo,
      student.gr_number,
      student.full_name,
      cert.docTitle,
      guardianPhone || session.phone,
      guardianPhone ? 1 : 0,
      new Date().toISOString(),
      JSON.stringify(cert),
      crypto.createHash("sha256").update(downloadToken).digest("hex"),
    );
  })();
  parentAuth.issued(sessionToken, serialNo, downloadToken);
  rotate();
  return { ...cert, downloadToken };
}
async function decorate(cert) {
  return {
    ...cert,
    ...renderCertificate({
      ...cert,
      verificationQr: await qr(cert.verificationUrl),
    }),
  };
}
app.post("/api/generate-document", requireParent, async (req, res) =>
  res.json(await decorate(issue(req.body, req.parentSession, parentToken(req))))
);
app.get("/api/documents/:serial/pdf", requireParent, async (req, res) => {
  if (!parentAuth.canDownload(parentToken(req), req.params.serial, req.headers["x-document-token"])) fail("Document download has expired.", 403);
  const row = db.prepare("SELECT certificate_json FROM issued_logs WHERE serial_no=?").get(req.params.serial);
  if (!row?.certificate_json) fail("Document download has expired.", 403);
  const c = await decorate(JSON.parse(row.certificate_json));
  res.set("Content-Disposition", `attachment; filename="${req.params.serial}.pdf"`).type("pdf").send(await pdf(c.certificateHtml));
});
app.get("/verify/:serial", async (req, res) => {
  const log = db
    .prepare(
      "SELECT serial_no,doc_title,issued_at FROM issued_logs WHERE serial_no=?",
    )
    .get(req.params.serial);
  const issuedDisplay = log
    ? (() => {
        const dt = new Date(log.issued_at);
        return Number.isNaN(dt.getTime())
          ? log.issued_at
          : dt.toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
              day: "2-digit",
              month: "short",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            });
      })()
    : "";
  res
    .status(log ? 200 : 404)
    .type("html")
    .send(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RJC · Verify certificate</title><style>*{box-sizing:border-box}body{margin:0;min-height:100dvh;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f3f2ee;color:#141414;padding:8vh 5vw}.sheet{max-width:640px;margin:auto;background:#faf9f6;border:1px solid #c8c7c0;border-top:4px solid #141414;padding:32px}.eyebrow{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#5f5f59;margin:0 0 10px}h1{font-weight:400;font-size:28px;letter-spacing:-.02em;margin:0 0 20px;padding-bottom:16px;border-bottom:1px solid #c8c7c0}.meta{display:grid;grid-template-columns:1fr;gap:14px;margin:0 0 20px}.lbl{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5f5f59;margin-bottom:3px}.val{display:block;font-size:17px;font-weight:600;overflow-wrap:anywhere}.note{margin:0;padding-top:16px;border-top:1px solid #c8c7c0;font-size:13px;color:#5f5f59}</style><main class="sheet"><p class="eyebrow">RJC · DOCUMENT VERIFICATION</p><h1>${log ? "School record found" : "Record not found"}</h1>${log ? `<div class="meta"><div><span class="lbl">Document</span><span class="val">${esc(log.doc_title)}</span></div><div><span class="lbl">Reference number</span><span class="val">${esc(log.serial_no)}</span></div><div><span class="lbl">Issued on</span><span class="val">${esc(issuedDisplay)}</span></div></div><p class="note">Verify identity and printed details with the school office. This page confirms the reference exists in school records; it does not verify altered printed content.</p>` : '<p class="note">Check the reference number printed on the certificate or contact the school office.</p>'}</main></html>`,
    );
});
app.post(
  "/api/admin/login",
  rateLimit({
    windowMs: 900000,
    limit: 15,
    message: { error: "Too many login attempts. Try again in 15 minutes." },
  }),
  (req, res) => {
    const username = text(req.body.username, "username", 100),
      password = text(req.body.password, "password", 256);
    const user = db
      .prepare("SELECT * FROM admin_users WHERE username=?")
      .get(username);
    if (!user || !checkPassword(password, user.password_hash))
      fail("Invalid administrator credentials.", 401);
    const token = crypto.randomBytes(32).toString("hex");
    tokens.set(token, Date.now() + 1800000);
    res.json({ token });
  },
);
app.use("/api/admin", requireAdmin);
app.post("/api/admin/guardian-approval", async (req, res) => {
  if (!canAccessLocalCounter(req)) fail("Approval is available only on the school counter PC.", 403);
  const admin = db.prepare("SELECT password_hash FROM admin_users WHERE username=?").get("admin");
  if (!admin || !checkPassword(String(req.body.password || ""), admin.password_hash)) fail("Invalid administrator credentials.", 401);
  const approval = parentAuth.approve(req.body.grNumber, req.body.guardianPhone);
  const url = `${portalUrl()}/?guardian=${encodeURIComponent(approval)}`;
  res.json({ url, qr: await qr(url), expiresIn: 600 });
});
app.post("/api/admin/logout", (req, res) => {
  tokens.delete(req.headers["x-admin-token"]);
  res.json({ ok: true });
});
app.get("/api/admin/dashboard", (req, res) =>
  res.json({
    settings: settings(),
    activePortalUrl: portalUrl(),
    students: db.prepare("SELECT * FROM students ORDER BY full_name").all(),
    templates: db.prepare("SELECT * FROM document_templates ORDER BY id").all(),
    logs: db
      .prepare(
        "SELECT serial_no,gr_number,student_name,doc_title,verified_phone,is_guardian,issued_at FROM issued_logs ORDER BY issued_at DESC",
      )
      .all(),
  }),
);
const csvCell = (value) => {
  const s = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return `"${safe.replace(/"/g, '""')}"`;
};
app.get("/api/admin/logs.csv", (req, res) => {
  const q = String(req.query.q || "").trim().toLocaleLowerCase();
  const rows = db
    .prepare(
      "SELECT serial_no,gr_number,student_name,doc_title,verified_phone,is_guardian,issued_at FROM issued_logs ORDER BY issued_at DESC",
    )
    .all()
    .filter((r) =>
      !q ||
      [r.serial_no, r.gr_number, r.student_name, r.doc_title, r.verified_phone, r.issued_at].some(
        (v) => String(v ?? "").toLocaleLowerCase().includes(q),
      ),
    );
  const header = "serial_no,gr_number,student_name,doc_title,verified_phone,is_guardian,issued_at";
  const lines = rows.map((r) =>
    [
      r.serial_no,
      r.gr_number,
      r.student_name,
      r.doc_title,
      r.verified_phone,
      r.is_guardian ? "Yes" : "No",
      r.issued_at,
    ]
      .map(csvCell)
      .join(","),
  );
  res
    .set("Content-Disposition", 'attachment; filename="issued-logs.csv"')
    .type("text/csv; charset=utf-8")
    .send("\uFEFF" + [header, ...lines].join("\r\n") + "\r\n");
});
app.post("/api/admin/change-password", (req, res) => {
  const old = text(req.body.currentPassword, "current password", 256),
    password = text(req.body.newPassword, "new password", 256);
  const user = db
    .prepare("SELECT * FROM admin_users WHERE username='admin'")
    .get();
  if (!checkPassword(old, user.password_hash))
    fail("Current password is incorrect.", 401);
  if (password.length < 10)
    fail("New password must have at least 10 characters.");
  db.prepare("UPDATE admin_users SET password_hash=? WHERE id=?").run(
    hashPassword(password),
    user.id,
  );
  fs.writeFileSync(
    path.join(dataDir, "admin-credentials.txt"),
    "Username: admin\nPassword was changed in Admin. The current password is stored only as a hash.\n",
    { mode: 0o600 },
  );
  tokens.clear();
  res.json({ ok: true });
});
function studentPhoto(value) {
  if (value == null || value === "") return "";
  if (
    typeof value !== "string" ||
    value.length > 2100000 ||
    !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)
  )
    fail("Upload a PNG, JPG, or WebP photo smaller than 1.5 MB.");
  const [, mime, b64] = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(value);
  const bytes = Buffer.from(b64, "base64");
  const isPng =
    mime === "png" &&
    bytes.length >= 24 &&
    bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" &&
    bytes.readUInt32BE(16) <= 6000 &&
    bytes.readUInt32BE(20) <= 6000;
  const isJpeg =
    mime === "jpeg" &&
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  const isWebp =
    mime === "webp" &&
    bytes.length >= 16 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!isPng && !isJpeg && !isWebp) fail("Invalid or oversized student photo.");
  return value;
}
function validateStudent(b) {
  const s = {};
  for (const k of [
    "gr_number",
    "full_name",
    "class_name",
    "division",
    "dob",
    "parent_phone",
  ])
    s[k] = text(b[k], k);
  s.father_name = text(b.father_name || "", "father name", 200, false);
  s.mother_name = text(b.mother_name || "", "mother name", 200, false);
  s.roll_no = text(b.roll_no || "", "roll number", 40, false);
  s.academic_year = text(b.academic_year || "", "academic year", 40, false);
  s.blood_group = text(b.blood_group || "", "blood group", 20, false);
  s.house = text(b.house || "", "house", 60, false);
  s.apaar_id = text(b.apaar_id || "", "APAAR ID", 64, false);
  s.emergency_phone = text(
    b.emergency_phone || "",
    "emergency mobile",
    20,
    false,
  );
  if (s.emergency_phone && !/^\d{10}$/.test(s.emergency_phone))
    fail("Emergency mobile must contain 10 digits.");
  s.bus_route = text(b.bus_route || "", "transport route", 120, false);
  s.address = text(b.address || "", "address", 300, false);
  s.remarks = text(b.remarks || "", "remarks", 200, false);
  s.photo_data = studentPhoto(b.photo_data);
  s.aadhaar_last4 = text(b.aadhaar_last4 || "", "Aadhaar last four", 4, false);
  if (s.aadhaar_last4 && !/^\d{4}$/.test(s.aadhaar_last4))
    fail("Store only the last four Aadhaar digits.");
  if (!/^\d{10}$/.test(s.parent_phone))
    fail("Parent mobile must contain 10 digits.");
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.dob);
  if (!m) fail("Date of birth must be DD/MM/YYYY.");
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  if (
    d.getFullYear() !== +m[3] ||
    d.getMonth() !== +m[2] - 1 ||
    d.getDate() !== +m[1] ||
    d > new Date() ||
    +m[3] < 1900
  )
    fail("Invalid date of birth.");
  s.birth_year = m[3];
  s.status = b.status === "INACTIVE" ? "INACTIVE" : "ACTIVE";
  return s;
}
const upsert = db.prepare(
  "INSERT INTO students(gr_number,full_name,father_name,mother_name,class_name,division,dob,birth_year,parent_phone,aadhaar_last4,roll_no,academic_year,blood_group,house,apaar_id,emergency_phone,bus_route,address,remarks,photo_data,status) VALUES(@gr_number,@full_name,@father_name,@mother_name,@class_name,@division,@dob,@birth_year,@parent_phone,@aadhaar_last4,@roll_no,@academic_year,@blood_group,@house,@apaar_id,@emergency_phone,@bus_route,@address,@remarks,@photo_data,@status) ON CONFLICT(gr_number) DO UPDATE SET full_name=excluded.full_name,father_name=excluded.father_name,mother_name=excluded.mother_name,class_name=excluded.class_name,division=excluded.division,dob=excluded.dob,birth_year=excluded.birth_year,parent_phone=excluded.parent_phone,aadhaar_last4=excluded.aadhaar_last4,roll_no=excluded.roll_no,academic_year=excluded.academic_year,blood_group=excluded.blood_group,house=excluded.house,apaar_id=excluded.apaar_id,emergency_phone=excluded.emergency_phone,bus_route=excluded.bus_route,address=excluded.address,remarks=excluded.remarks,photo_data=CASE WHEN excluded.photo_data='' AND @preserve_photo=1 THEN students.photo_data ELSE excluded.photo_data END,status=excluded.status",
);
app.post("/api/admin/students", (req, res) => {
  const preserve_photo = req.body.photo_data === undefined ? 1 : 0;
  upsert.run({ ...validateStudent(req.body), preserve_photo });
  res.json({ ok: true });
});
app.delete("/api/admin/students/:gr", (req, res) => {
  if (
    !db
      .prepare("UPDATE students SET status='INACTIVE' WHERE gr_number=?")
      .run(req.params.gr).changes
  )
    fail("Student not found.", 404);
  res.json({ ok: true });
});
app.post("/api/admin/students/bulk", (req, res) => {
  let rows;
  if (typeof req.body.csv === "string") {
    rows = parse(req.body.csv, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      trim: true,
    });
  } else rows = req.body.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 5000)
    fail("Import between 1 and 5000 students.");
  const validated = rows.map((r, i) => {
    try {
      return validateStudent(r);
    } catch (e) {
      fail(`CSV row ${i + 2}: ${e.message}`);
    }
  });
  db.transaction(() => {
    for (const r of validated) upsert.run({ ...r, preserve_photo: r.photo_data ? 0 : 1 });
  })();
  res.json({ ok: true, count: rows.length });
});
app.get("/api/admin/sample.csv", (req, res) =>
  res
    .set("Content-Disposition", 'attachment; filename="sample-students.csv"')
    .type("text/csv")
    .send(
      "gr_number,full_name,father_name,class_name,division,dob,aadhaar_last4,parent_phone\r\n9901,Sample Student Patil,Sample Parent Patil,8th,A,14/06/2013,1234,9800000001\r\n",
    ),
);
function template(b) {
  const out = {};
  for (const k of ["title_mr", "title_hi", "title_en"])
    out[k] = text(b[k], k, 200);
  out.body_html = clean(text(b.body_html, "English template body", 30000));
  out.body_mr = clean(text(b.body_mr || "", "Marathi body", 30000, false));
  out.body_hi = clean(text(b.body_hi || "", "Hindi body", 30000, false));
  for (const k of ["sig_pos", "stamp_pos"]) {
    out[k] = b[k] || "right";
    if (!["left", "center", "right", "none"].includes(out[k]))
      fail("Invalid image position.");
  }
  out.is_active = b.is_active === 0 ? 0 : 1;
  return out;
}
app.post("/api/admin/templates", (req, res) => {
  const t = template(req.body);
  const result = db
    .prepare(
      "INSERT INTO document_templates(title_mr,title_hi,title_en,body_html,body_mr,body_hi,sig_pos,stamp_pos,is_active) VALUES(@title_mr,@title_hi,@title_en,@body_html,@body_mr,@body_hi,@sig_pos,@stamp_pos,@is_active)",
    )
    .run(t);
  res.json({ ok: true, id: Number(result.lastInsertRowid) });
});
app.put("/api/admin/templates/:id", (req, res) => {
  const t = template(req.body);
  if (
    !db
      .prepare(
        "UPDATE document_templates SET title_mr=@title_mr,title_hi=@title_hi,title_en=@title_en,body_html=@body_html,body_mr=@body_mr,body_hi=@body_hi,sig_pos=@sig_pos,stamp_pos=@stamp_pos,is_active=@is_active WHERE id=@id",
      )
      .run({ ...t, id: Number(req.params.id) }).changes
  )
    fail("Template not found.", 404);
  res.json({ ok: true });
});
app.patch("/api/admin/templates/:id", (req, res) => {
  if (![0, 1].includes(req.body.is_active))
    fail("Active status must be 0 or 1.");
  if (
    !db
      .prepare("UPDATE document_templates SET is_active=? WHERE id=?")
      .run(req.body.is_active, Number(req.params.id)).changes
  )
    fail("Template not found.", 404);
  res.json({ ok: true });
});
app.delete("/api/admin/templates/:id", (req, res) => {
  if (
    !db
      .prepare("DELETE FROM document_templates WHERE id=?")
      .run(Number(req.params.id)).changes
  )
    fail("Template not found.", 404);
  res.json({ ok: true });
});
function png(value) {
  if (value == null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 2100000 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)
  )
    fail("Upload a PNG smaller than 1.5 MB.");
  const bytes = Buffer.from(value.split(",")[1], "base64");
  if (
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.readUInt32BE(16) > 6000 ||
    bytes.readUInt32BE(20) > 6000
  )
    fail("Invalid or oversized PNG.");
  return value;
}
app.post("/api/admin/settings", (req, res) => {
  const old = settings();
  const s = { ...old };
  for (const k of [
    "school_name",
    "school_subtitle",
    "udise_no",
    "whatsapp_number",
    "wifi_ssid",
    "wifi_password",
  ])
    if (req.body[k] !== undefined)
      s[k] = text(
        req.body[k],
        k,
        k === "wifi_password" ? 128 : 300,
        k === "school_name",
      );
  if (req.body.udise_no !== undefined) s.udise_no = normalizeUdise(s.udise_no);
  if (req.body.public_url !== undefined) {
    const raw = text(
      req.body.public_url || "",
      "public tunnel URL",
      300,
      false,
    );
    if (raw && !normalizePortalUrl(raw))
      fail(
        "Public tunnel URL must be a valid http(s) URL, e.g. https://<name>.trycloudflare.com",
      );
    s.public_url = raw ? normalizePortalUrl(raw) : "";
  }
  for (const k of ["logo_data", "signature_data", "stamp_data"])
    if (req.body[k] !== undefined) s[k] = png(req.body[k]);
  db.prepare(
    "UPDATE school_settings SET school_name=@school_name,school_subtitle=@school_subtitle,udise_no=@udise_no,whatsapp_number=@whatsapp_number,wifi_ssid=@wifi_ssid,wifi_password=@wifi_password,logo_data=@logo_data,signature_data=@signature_data,stamp_data=@stamp_data,public_url=@public_url WHERE id=1",
  ).run(s);
  qrCache = null;
  res.json({ ok: true });
});
app.post("/api/admin/template-preview", async (req, res) => {
  const t = template(req.body);
  const lang = ["mr", "hi", "en"].includes(req.body.lang)
    ? req.body.lang
    : "en";
  const vals = {
    student_name: "Aarav Sunil Patil",
    father_name: "Sunil Patil",
    class_name: "8th",
    division: "A",
    gr_number: "4501",
    dob: "14/06/2013",
    issue_date: new Date().toLocaleDateString("en-IN"),
  };
  const body = (
    lang === "en" ? t.body_html : t["body_" + lang] || t.body_html
  ).replace(/{{(\w+)}}/g, (_, k) => esc(vals[k] || ""));
  res.json(
    await decorate({
      serialNo: "PREVIEW",
      issuedAt: vals.issue_date,
      docTitle: t["title_" + lang],
      bodyHtml: body,
      sigPos: t.sig_pos,
      stampPos: t.stamp_pos,
      lang,
      settings: safeSettings(),
      verificationUrl: portalUrl() + "/verify/PREVIEW",
    }),
  );
});
app.post("/api/admin/backup", async (req, res) => {
  const dir = path.join(dataDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const filename =
    "school-" + new Date().toISOString().replace(/[:.]/g, "-") + ".db";
  await db.backup(path.join(dir, filename));
  res.json({ ok: true, filename });
});
const { createWhatsApp } = require("./whatsapp");
const wa = createWhatsApp({ db, issue: () => fail("Use the verified parent portal.", 403), decorate, pdf, settings, fail });
app.get("/webhook", wa.verify);
// The former conversational issuance flow predates parent sessions. It is
// disabled; outbound authentication templates use the OTP transport above.
app.post("/webhook", (req, res) => res.sendStatus(410));
app.get(["/", "/admin"], (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html")),
);
app.use(express.static(path.join(__dirname, "public")));
app.use("/api", (req, res) =>
  res.status(404).json({ error: "API route not found." }),
);
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status =
    err.status || (String(err.code || "").startsWith("CSV_") ? 400 : 500);
  res.status(status).json({
    error:
      status === 413
        ? "Upload exceeds 8 MB."
        : status >= 500
          ? "The operation could not be completed. Please try again."
          : err.message || "Invalid request.",
  });
});
const server = app.listen(port, process.env.HOST || "0.0.0.0", () =>
  console.log(
    `RJC — School Document Portal\nSchool monitor: http://localhost:${port}\nPortal link (used in the phone QR): ${portalUrl()}\nAdmin: see ${path.join(dataDir, "admin-credentials.txt")}\nSample GR / birth year / Aadhaar last four: 4501/2013/1234, 4502/2011/2345, 4503/2012/3456, 4504/2014/4567, 4505/2015/5678, 4506/2013 (no Aadhaar suffix)`,
  ),
);
server.on("error", (e) => {
  console.error(
    e.code === "EADDRINUSE"
      ? `Port ${port} is in use. Close the previous kiosk server first.`
      : e.message,
  );
  db.close();
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    clearInterval(ticker);
    clearInterval(backupTimer);
    clearTimeout(startupBackup);
    wa.close();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
