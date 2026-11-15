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
const { createApprovalService, formatIstDateTime } = require("./approval-service");
const { createTelegramBot } = require("./telegram");
const { createPrintQueue } = require("./print-queue");
const { createNotifyService } = require("./notify-service");
const { buildZipBuffer } = require("./zip-export");
const {
  computeVerificationSeal,
  verifyVerificationSeal,
  computePrintCopySeal,
} = require("./verification-seal");
const Database = require("better-sqlite3");
const {
  encryptBackupBuffer,
  verifySqliteSnapshot,
  checkDbHealth,
  MIN_PASSPHRASE_LENGTH,
} = require("./backup-crypto");
const {
  normalizeClassName,
  normalizeDivision,
  normalizeDobValue,
  parseStudentImport,
  buildStudentsExport,
  buildSampleStudentsXlsx,
  buildLogsExport,
  buildAllDataExport,
} = require("./data-exchange");
const dataDir = process.env.KIOSK_DATA_DIR || __dirname;
const port = Number(process.env.PORT || 3000);
const db = openDatabase(dataDir);
const startupHealth = checkDbHealth(db, path.join(dataDir, "school.db"));
if (!startupHealth.ok) {
  console.error(
    `[DB WARNING] SQLite quick_check reported: ${startupHealth.quickCheck}. Restore from a verified backup immediately!`,
  );
} else {
  console.log(
    `[DB OK] journal=${startupHealth.journalMode} sync=${startupHealth.synchronous} quick_check=${startupHealth.quickCheck} students=${startupHealth.counts.students}`,
  );
}
const interfaces = Object.values(os.networkInterfaces())
  .flat()
  .filter(
    (i) =>
      i.family === "IPv4" &&
      !i.internal &&
      !String(i.address || "").startsWith("169.254."),
  );
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
const toPublicCloudRunUrl = (value) => {
  const norm = normalizePortalUrl(value);
  if (!norm) return null;
  return norm.replace(/^https:\/\/ais-dev-/i, "https://ais-pre-");
};
// Base URL used inside the phone QR and certificate verification QR:
// Admin setting -> .env -> auto-detected tunnel (public-url file) -> Cloud Run URL -> LAN fallback.
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
  if (port === 3000) {
    const hosted = toPublicCloudRunUrl(
      process.env.SHARED_APP_URL || process.env.APP_URL || "",
    );
    if (hosted) return hosted;
  }
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
  if (normalized) {
    allowedHosts.add(new URL(normalized).hostname);
    const pub = toPublicCloudRunUrl(normalized);
    if (pub) allowedHosts.add(new URL(pub).hostname);
  }
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
    (p === "/" ||
      p === "/index.html" ||
      p === "/favicon.ico" ||
      p === "/teacher" ||
      p === "/teacher.html" ||
      p === "/kiosk" ||
      p === "/parent-screen" ||
      p === "/face-check.js" ||
      p === "/keypad-history.js" ||
      p === "/dual-monitor.js")
  )
    return true;
  if (req.method === "GET" && /^\/m\/[A-Za-z0-9_-]+$/.test(p)) return true;
  if (req.method === "GET" && /^\/upload\/[A-Za-z0-9_-]+$/.test(p))
    return true;
  if (req.method === "GET" && p.startsWith("/fonts/")) return true;
  if (req.method === "GET" && p === "/api/public-config") return true;
  if (
    req.method === "GET" &&
    (p === "/api/teacher/roster" ||
      p === "/api/teacher/requests" ||
      /^\/api\/teacher\/requests\/[A-Za-z0-9_-]+\/attachment$/.test(p))
  )
    return true;
  if (
    req.method === "POST" &&
    (p === "/api/teacher/login" ||
      p === "/api/teacher/logout" ||
      /^\/api\/teacher\/requests\/[A-Za-z0-9_-]+\/(approve|reject|release-print)$/.test(p))
  )
    return true;
  if (
    req.method === "POST" &&
    (p === "/api/search-student" ||
      p === "/api/generate-document" ||
      p.startsWith("/api/parent/") ||
      /^\/api\/upload\/[A-Za-z0-9_-]+$/.test(p))
  )
    return true;
  if (
    req.method === "GET" &&
    (p === "/api/parent/students" ||
      /^\/api\/parent\/request-status\/[A-Za-z0-9_-]+$/.test(p) ||
      /^\/api\/parent\/upload-status\/[A-Za-z0-9_-]+$/.test(p))
  )
    return true;
  if (
    req.method === "DELETE" &&
    /^\/api\/parent\/upload-session\/[A-Za-z0-9_-]+$/.test(p)
  )
    return true;
  if (req.method === "GET" && /^\/api\/documents\/[^/]+\/pdf$/.test(p))
    return true;
  if (req.method === "GET" && /^\/verify\/[^/]+$/.test(p)) return true;
  return false;
};
const mobileParentSessions = new Map();
function readCookies(req) {
  const out = {};
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}
function isMobileParentSession(req) {
  const cookies = readCookies(req);
  const sid = cookies.rjc_mobile_parent;
  if (!sid) return false;
  const entry = mobileParentSessions.get(sid);
  if (!entry || entry.expiresAt <= Date.now()) {
    mobileParentSessions.delete(sid);
    return false;
  }
  return true;
}
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
    ["localhost", "127.0.0.1", "[::1]"].includes(portalHost) ||
    isHostedPreviewHost(portalHost);
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
  if (
    isMobileParentSession(req) &&
    (req.path === "/admin" ||
      req.path.startsWith("/api/admin") ||
      req.path === "/api/campus-code" ||
      req.path.startsWith("/api/kiosk"))
  ) {
    return res.status(403).json({
      error: "Admin access is blocked on mobile parent QR sessions.",
    });
  }
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
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; frame-src 'self' about: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'",
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
  const {
    wifi_ssid,
    wifi_password,
    telegram_bot_token,
    telegram_storage_chat_id,
    staff_join_code,
    smtp_pass,
    smtp_user,
    whatsapp_token,
    verification_secret,
    ...s
  } = settings();
  return s;
};
function requireAdmin(req, res, next) {
  if (isMobileParentSession(req)) {
    return res.status(403).json({ error: "Admin access is not permitted from parent QR sessions." });
  }
  const t = req.headers["x-admin-token"];
  if (!t || !tokens.has(t) || tokens.get(t) < Date.now()) {
    tokens.delete(t);
    return res
      .status(401)
      .json({ error: "Admin session expired. Please sign in." });
  }
  next();
}
const teacherTokens = new Map();
function requireTeacher(req, res, next) {
  const t = String(req.headers["x-teacher-token"] || req.query.t || "");
  const entry = teacherTokens.get(t);
  if (!t || !entry || entry.expiresAt < Date.now()) {
    teacherTokens.delete(t);
    return res.status(401).json({ error: "Teacher sign in required." });
  }
  const teacher = db
    .prepare("SELECT id, name, role, is_top_teacher, is_active FROM teachers WHERE id=? AND is_active=1")
    .get(entry.teacherId);
  if (!teacher) {
    teacherTokens.delete(t);
    return res.status(401).json({ error: "Teacher account inactive." });
  }
  req.teacher = teacher;
  req.teacherToken = t;
  next();
}
function requireStaffOrAdmin(req, res, next) {
  if (isMobileParentSession(req)) {
    return res.status(403).json({ error: "Counter desk is not accessible from parent QR sessions." });
  }
  const adminTok = String(req.headers["x-admin-token"] || "");
  if (adminTok && tokens.has(adminTok) && tokens.get(adminTok) >= Date.now()) {
    req.staffActor = {
      id: null,
      name: "School Office Admin",
      role: "Administrator",
      isTopTeacher: true,
      is_top_teacher: 1,
      isAdmin: true,
    };
    return next();
  }
  if (adminTok) tokens.delete(adminTok);

  const teacherTok = String(req.headers["x-teacher-token"] || req.query.t || "");
  const entry = teacherTokens.get(teacherTok);
  if (teacherTok && entry && entry.expiresAt >= Date.now()) {
    const teacher = db
      .prepare("SELECT id, name, role, is_top_teacher, is_active FROM teachers WHERE id=? AND is_active=1")
      .get(entry.teacherId);
    if (teacher) {
      req.staffActor = {
        id: teacher.id,
        name: teacher.name,
        role: teacher.role || "Staff",
        isTopTeacher: Boolean(teacher.is_top_teacher),
        is_top_teacher: teacher.is_top_teacher ? 1 : 0,
        isAdmin: false,
      };
      return next();
    }
    teacherTokens.delete(teacherTok);
  }
  return res.status(401).json({ error: "Staff PIN or Admin sign in required." });
}
let campus = {
  code: String(crypto.randomInt(1000, 10000)),
  expiresAt: Date.now() + 60000,
};
let qrCache;
let activeHandoffToken = "";
function rotate() {
  campus = {
    code: String(
      ((+campus.code - 1000 + crypto.randomInt(1, 9000)) % 9000) + 1000,
    ),
    expiresAt: Date.now() + 60000,
  };
  qrCache = null;
}
function ensureHandoffToken() {
  const now = Date.now();
  db.prepare("DELETE FROM qr_handoff_tokens WHERE expires_at <= ? OR (status='USED' AND used_at <= ?)").run(
    now,
    now - 3600000,
  );
  if (activeHandoffToken) {
    const existing = db
      .prepare("SELECT token, status, expires_at FROM qr_handoff_tokens WHERE token=?")
      .get(activeHandoffToken);
    if (existing && existing.status === "ACTIVE" && existing.expires_at > now + 5000) {
      return existing.token;
    }
    if (existing && existing.status === "ACTIVE") {
      db.prepare("UPDATE qr_handoff_tokens SET status='EXPIRED' WHERE token=?").run(existing.token);
    }
  }
  const next = crypto.randomBytes(18).toString("base64url");
  db.prepare(
    "INSERT INTO qr_handoff_tokens(token, status, issued_at, expires_at) VALUES(?,?,?,?)",
  ).run(next, "ACTIVE", now, now + 120000);
  activeHandoffToken = next;
  return next;
}
const ticker = setInterval(() => {
  if (Date.now() >= campus.expiresAt) rotate();
  for (const [t, e] of tokens) if (e < Date.now()) tokens.delete(t);
  for (const [t, e] of teacherTokens) if (e.expiresAt < Date.now()) teacherTokens.delete(t);
  for (const [t, e] of mobileParentSessions) if (e.expiresAt <= Date.now()) mobileParentSessions.delete(t);
}, 1000);
ticker.unref();
// Automatic backup: if today's snapshot is missing, create it 10s after startup
// (and every 24h afterwards). Verifies SQLite integrity, keeps 14 rolling copies,
// and optionally mirrors to external BACKUP_DIR (encrypted if BACKUP_PASSPHRASE is set).
const autoBackupName = (date) => {
  const y = date.getFullYear(),
    m = String(date.getMonth() + 1).padStart(2, "0"),
    d = String(date.getDate()).padStart(2, "0");
  return `auto-${y}-${m}-${d}.db`;
};
async function mirrorBackupExternal(localSnapPath, date) {
  const extDirRaw = String(process.env.BACKUP_DIR || "").trim();
  if (!extDirRaw) return { mirrored: false, encrypted: false };
  const extDir = path.resolve(extDirRaw);
  fs.mkdirSync(extDir, { recursive: true });
  const baseName = autoBackupName(date);
  const pass = String(process.env.BACKUP_PASSPHRASE || "");
  let encrypted = false;
  if (pass.trim().length >= MIN_PASSPHRASE_LENGTH) {
    const encName = baseName.replace(/\.db$/, ".rjcbackup");
    const encDest = path.join(extDir, encName);
    if (!fs.existsSync(encDest)) {
      const encBuf = encryptBackupBuffer(fs.readFileSync(localSnapPath), pass);
      fs.writeFileSync(encDest, encBuf);
    }
    encrypted = true;
    const extEnc = fs
      .readdirSync(extDir)
      .filter((f) => /^auto-\d{4}-\d{2}-\d{2}\.rjcbackup$/.test(f))
      .sort();
    for (const f of extEnc.slice(0, Math.max(0, extEnc.length - 14))) {
      fs.unlinkSync(path.join(extDir, f));
    }
  } else {
    const extDest = path.join(extDir, baseName);
    if (!fs.existsSync(extDest)) {
      fs.copyFileSync(localSnapPath, extDest);
    }
    const extPlain = fs
      .readdirSync(extDir)
      .filter((f) => /^auto-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort();
    for (const f of extPlain.slice(0, Math.max(0, extPlain.length - 14))) {
      fs.unlinkSync(path.join(extDir, f));
    }
  }
  return { mirrored: true, encrypted, extDir };
}
async function autoBackup() {
  try {
    const now = new Date();
    const dir = path.join(dataDir, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, autoBackupName(now));
    if (!fs.existsSync(dest)) {
      await db.backup(dest);
      verifySqliteSnapshot(Database, dest);
      console.log("Automatic verified backup saved: " + dest);
    }
    try {
      await mirrorBackupExternal(dest, now);
    } catch (extErr) {
      console.warn(
        "External BACKUP_DIR mirror skipped: " + (extErr?.message || extErr),
      );
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
  if (!canAccessLocalCounter(req) || isMobileParentSession(req))
    return res
      .status(403)
      .json({ error: "Campus code is shown on the school monitor only." });
  if (Date.now() >= campus.expiresAt) rotate();
  const handoffToken = ensureHandoffToken();
  if (!qrCache || qrCache.handoffToken !== handoffToken) {
    const snapshot = { ...campus };
    const s = settings();
    const base = requestPortalBase(req);
    const url = `${base}/m/${handoffToken}`;
    const wifi = s.wifi_ssid
      ? `WIFI:T:WPA;S:${wifiEscape(s.wifi_ssid)};P:${wifiEscape(s.wifi_password)};;`
      : null;
    const data = {
      ...snapshot,
      handoffToken,
      lanIp,
      portalUrl: base,
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
app.get("/m/:token", (req, res) => {
  const tok = String(req.params.token || "").trim();
  const now = Date.now();
  const redeemed = db.transaction(() => {
    const row = db
      .prepare("SELECT * FROM qr_handoff_tokens WHERE token=?")
      .get(tok);
    if (!row || row.status !== "ACTIVE" || row.expires_at <= now) {
      return null;
    }
    const mobileSid = crypto.randomBytes(24).toString("base64url");
    db.prepare(
      "UPDATE qr_handoff_tokens SET status='USED', mobile_session_id=?, used_at=? WHERE token=? AND status='ACTIVE'",
    ).run(mobileSid, now, tok);
    return mobileSid;
  })();

  if (!redeemed) {
    const schoolName = esc(settings().school_name || "R. J. CHAWARE CONVENT");
    return res
      .status(410)
      .type("html")
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${schoolName} · QR Expired</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:#f3f2ee;color:#141414;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.sheet{max-width:460px;width:100%;background:#faf9f6;border:1px solid #c8c7c0;border-top:4px solid #141414;padding:28px}.eyebrow{font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#5f5f59;margin:0 0 8px}h1{font-weight:400;font-size:24px;margin:0 0 10px}p{margin:0;color:#5f5f59}</style><main class="sheet"><p class="eyebrow">${schoolName}</p><h1>This QR code has expired</h1><p>Each phone QR code can be used once. Look at the school monitor screen and scan the new QR code to open the portal in Chrome.</p></main></html>`,
      );
  }

  if (activeHandoffToken === tok) {
    activeHandoffToken = "";
    qrCache = null;
  }
  while (mobileParentSessions.size >= 2000) {
    mobileParentSessions.delete(mobileParentSessions.keys().next().value);
  }
  mobileParentSessions.set(redeemed, {
    usedToken: tok,
    expiresAt: now + 30 * 60 * 1000,
  });
  res.setHeader(
    "Set-Cookie",
    `rjc_mobile_parent=${encodeURIComponent(redeemed)}; Path=/; Max-Age=1800; HttpOnly; SameSite=Lax`,
  );
  res.redirect(302, "/?pm=1");
});
app.get("/api/public-config", (req, res) => res.json({
  schoolName: settings().school_name, schoolSubtitle: settings().school_subtitle,
  schoolTagline: String(settings().school_subtitle || "").split("•")[0].trim(),
  portalUrl: portalUrl(), otpConfigured: otpTransport.configured(),
  mobileParentOnly: isMobileParentSession(req),
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
app.post("/api/parent/family", parentRate, (req, res) => res.json(parentAuth.verifyFamily(req.body.challengeId, req.body.birthMonth, req.body.birthYear, req.body.grNumber ?? req.body.identifier, req.body.identifierType)));
app.post("/api/parent/guardian", parentRate, (req, res) => res.json(parentAuth.redeem(req.body.approval)));
const bonafideUploads = new Map();
const UPLOAD_SESSION_TTL = 15 * 60 * 1000;
function pruneUploads() {
  const now = Date.now();
  for (const [k, entry] of bonafideUploads) {
    if (entry.expiresAt <= now) bonafideUploads.delete(k);
  }
}
function requestPortalBase(req) {
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
  if (isHostedPreviewHost(req.hostname)) {
    const host = String(req.get("x-forwarded-host") || req.headers.host || "").trim();
    if (host) return `https://${host}`.replace(/^https:\/\/ais-dev-/i, "https://ais-pre-");
  }
  return portalUrl();
}
function validateSupportingDoc(dataUrl, rawName) {
  if (typeof dataUrl !== "string" || dataUrl.length > 7400000) {
    fail("Upload a PDF, PNG, JPG, or WebP file smaller than 5 MB.");
  }
  const match =
    /^data:(application\/pdf|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/=]+)$/.exec(
      dataUrl,
    );
  if (!match) fail("Choose a PDF, PNG, JPG, or WebP file.");
  const mime = match[1];
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) {
    fail("File must be smaller than 5 MB.");
  }
  const isPdf =
    mime === "application/pdf" &&
    bytes.length >= 5 &&
    bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  const isPng =
    mime === "image/png" &&
    bytes.length >= 24 &&
    bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  const isJpeg =
    mime === "image/jpeg" &&
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  const isWebp =
    mime === "image/webp" &&
    bytes.length >= 16 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!isPdf && !isPng && !isJpeg && !isWebp) {
    fail("Invalid or corrupted PDF or image file.");
  }
  const safeBase =
    String(rawName || "supporting-document")
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
      .trim()
      .slice(0, 120) || "supporting-document";
  return {
    fileName: safeBase,
    mime,
    size: bytes.length,
    dataUrl: `data:${mime};base64,${bytes.toString("base64")}`,
    uploadedAt: Date.now(),
  };
}
app.post("/api/parent/upload-session", requireParent, async (req, res) => {
  pruneUploads();
  const gr = req.parentSession.refs.get(String(req.body.studentRef || ""));
  if (!gr) fail("Verification required.", 403);
  const sessToken = parentToken(req);
  for (const [k, v] of bonafideUploads) {
    if (v.sessionToken === sessToken && v.grNumber === gr) {
      const uploadUrl = `${requestPortalBase(req)}/upload/${k}`;
      return res.json({
        uploadToken: k,
        uploadUrl,
        qr: await qr(uploadUrl),
        expiresIn: Math.max(1, Math.floor((v.expiresAt - Date.now()) / 1000)),
        uploaded: Boolean(v.file),
        fileName: v.file?.fileName || "",
        size: v.file?.size || 0,
      });
    }
  }
  while (bonafideUploads.size >= 2000) {
    bonafideUploads.delete(bonafideUploads.keys().next().value);
  }
  const uploadToken = crypto.randomBytes(24).toString("base64url");
  bonafideUploads.set(uploadToken, {
    sessionToken: sessToken,
    grNumber: gr,
    expiresAt: Date.now() + UPLOAD_SESSION_TTL,
    file: null,
  });
  const uploadUrl = `${requestPortalBase(req)}/upload/${uploadToken}`;
  res.json({
    uploadToken,
    uploadUrl,
    qr: await qr(uploadUrl),
    expiresIn: Math.floor(UPLOAD_SESSION_TTL / 1000),
    uploaded: false,
    fileName: "",
    size: 0,
  });
});
app.get("/api/parent/upload-status/:token", requireParent, (req, res) => {
  pruneUploads();
  const entry = bonafideUploads.get(String(req.params.token || ""));
  if (!entry || entry.sessionToken !== parentToken(req)) {
    fail("Upload link expired.", 404);
  }
  res.json({
    uploaded: Boolean(entry.file),
    fileName: entry.file?.fileName || "",
    mime: entry.file?.mime || "",
    size: entry.file?.size || 0,
  });
});
app.delete("/api/parent/upload-session/:token", requireParent, (req, res) => {
  const entry = bonafideUploads.get(String(req.params.token || ""));
  if (entry && entry.sessionToken === parentToken(req)) entry.file = null;
  res.json({ ok: true });
});
app.get("/upload/:token", (req, res) => {
  pruneUploads();
  const token = String(req.params.token || "");
  const entry = bonafideUploads.get(token);
  const valid = Boolean(entry && entry.expiresAt > Date.now());
  const schoolName = esc(settings().school_name || "R. J. CHAWARE CONVENT");
  res
    .status(valid ? 200 : 410)
    .type("html")
    .send(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Upload Supporting Document</title><style>*{box-sizing:border-box}body{margin:0;min-height:100dvh;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f3f2ee;color:#141414;padding:24px 16px}.sheet{max-width:520px;margin:0 auto;background:#faf9f6;border:1px solid #c8c7c0;border-top:4px solid #141414;padding:28px 24px}.eyebrow{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#5f5f59;margin:0 0 8px}h1{font-weight:400;font-size:26px;letter-spacing:-.02em;margin:0 0 10px}p{margin:0 0 16px;color:#5f5f59}input[type=file]{display:none}.bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;border:1px solid #c8c7c0;background:#f3f2ee;padding:10px 12px;margin-bottom:16px}.btn{cursor:pointer;border:1px solid #141414;background:#f3f2ee;color:#141414;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;font-weight:500;padding:10px 16px;min-height:42px}.btn.primary{width:100%;background:#141414;color:#f3f2ee;min-height:48px}.btn:disabled{opacity:.4;cursor:not-allowed}.fname{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;color:#5f5f59;overflow-wrap:anywhere}.status{margin:14px 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;min-height:22px;color:#141414}.status.err{color:#a32620}</style><main class="sheet"><p class="eyebrow">${schoolName} · DOCUMENT UPLOAD</p><h1>${valid ? "Upload application or proof" : "Upload link expired"}</h1><p>${valid ? "Choose a PDF or photo (PNG, JPG, WebP) from your phone. Once uploaded, return to the school screen." : "Return to the school screen and select Bonafide Certificate again to get a fresh QR code."}</p>${valid ? `<div class="bar"><button type="button" class="btn" id="pick-btn">Choose PDF or Photo</button><span class="fname" id="file-name">${entry.file ? esc(entry.file.fileName + " · already uploaded") : "No file selected"}</span><input id="doc-input" type="file" accept="application/pdf,image/png,image/jpeg,image/webp"></div><button type="button" class="btn primary" id="upload-btn" disabled>Upload document</button><p class="status" id="upload-status"></p><script>const token=${JSON.stringify(token)};const input=document.getElementById("doc-input"),pick=document.getElementById("pick-btn"),btn=document.getElementById("upload-btn"),fname=document.getElementById("file-name"),st=document.getElementById("upload-status");let pending=null;pick.onclick=()=>input.click();input.onchange=()=>{const f=input.files[0];if(!f)return;if(f.size>5*1024*1024){st.className="status err";st.textContent="Choose a file smaller than 5 MB.";input.value="";return;}const r=new FileReader();r.onload=()=>{pending={fileName:f.name,dataUrl:r.result};fname.textContent=f.name;st.className="status";st.textContent="";btn.disabled=false;};r.onerror=()=>{st.className="status err";st.textContent="Unable to read this file.";};r.readAsDataURL(f);};btn.onclick=async()=>{if(!pending)return;btn.disabled=true;st.className="status";st.textContent="Uploading…";try{const res=await fetch("/api/upload/"+encodeURIComponent(token),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(pending)});const d=await res.json();if(!res.ok)throw Error(d.error||"Upload failed.");st.className="status";st.textContent="Uploaded: "+d.fileName+". You can return to the school screen.";fname.textContent=d.fileName+" ✓";}catch(e){st.className="status err";st.textContent=e.message;btn.disabled=false;}};</script>` : ""}</main></html>`,
    );
});
app.post("/api/upload/:token", parentRate, (req, res) => {
  pruneUploads();
  const entry = bonafideUploads.get(String(req.params.token || ""));
  if (!entry || entry.expiresAt <= Date.now()) {
    fail("Upload link expired.", 410);
  }
  const validated = validateSupportingDoc(req.body.dataUrl, req.body.fileName);
  entry.file = validated;
  res.json({
    ok: true,
    fileName: validated.fileName,
    mime: validated.mime,
    size: validated.size,
  });
});
function validateFacePhoto(dataUrl) {
  if (
    typeof dataUrl !== "string" ||
    dataUrl.length > 2100000 ||
    !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)
  ) {
    fail("Capture a clear face photo first.");
  }
  const [, mime, b64] = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(dataUrl);
  const bytes = Buffer.from(b64, "base64");
  const isPng =
    mime === "png" &&
    bytes.length >= 24 &&
    bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
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
  if ((!isPng && !isJpeg && !isWebp) || bytes.length < 64) {
    fail("Captured face image is invalid or incomplete.");
  }
  return dataUrl;
}
app.post("/api/parent/face-proof", requireParent, (req, res) => {
  const photoData = validateFacePhoto(req.body.photoData);
  res.json(parentAuth.setFaceProof(parentToken(req), photoData));
});
app.post("/api/parent/done", (req, res) => {
  const token = parentToken(req);
  for (const [k, v] of bonafideUploads) {
    if (v.sessionToken === token) bonafideUploads.delete(k);
  }
  parentAuth.finish(token);
  res.sendStatus(204);
});
app.get("/api/parent/students", requireParent, (req, res) => {
  if (!req.parentSession.faceVerified) {
    fail("Complete live face proof before viewing student records.", 403);
  }
  const students = [...req.parentSession.refs].map(([studentRef, gr]) => ({
    studentRef,
    ...db.prepare("SELECT gr_number,full_name,father_name,mother_name,class_name,division,dob,roll_no,academic_year,blood_group,house,apaar_id,parent_phone,emergency_phone,bus_route,address,remarks,photo_data FROM students WHERE gr_number=? AND status='ACTIVE'").get(gr),
  }));
  res.json({ students, templates: db.prepare("SELECT id,title_mr,title_hi,title_en FROM document_templates WHERE is_active=1").all() });
});
app.post("/api/search-student", requireParent, (req, res) => {
  if (!req.parentSession.faceVerified) {
    fail("Complete live face proof first.", 403);
  }
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
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 200) : "";
  let docRecord = null;
  if (typeof b.uploadToken === "string" && b.uploadToken.trim()) {
    pruneUploads();
    const entry = bonafideUploads.get(b.uploadToken.trim());
    if (
      entry &&
      entry.sessionToken === sessionToken &&
      entry.grNumber === student.gr_number &&
      entry.file
    ) {
      docRecord = entry.file;
      bonafideUploads.delete(b.uploadToken.trim());
    }
  }
  const downloadToken = crypto.randomBytes(32).toString("hex");
  const cert = {
    serialNo,
    issuedAt,
    docTitle: tpl["title_" + lang],
    reason,
    supportingDocName: docRecord?.fileName || "",
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
      "INSERT INTO issued_logs(serial_no,gr_number,student_name,doc_title,verified_phone,is_guardian,issued_at,issued_year,certificate_json,download_hash,reason,supporting_doc_name,supporting_doc_mime,supporting_doc_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      serialNo,
      student.gr_number,
      student.full_name,
      cert.docTitle,
      guardianPhone || session.phone,
      guardianPhone ? 1 : 0,
      new Date().toISOString(),
      Number(year),
      JSON.stringify(cert),
      crypto.createHash("sha256").update(downloadToken).digest("hex"),
      reason,
      docRecord?.fileName || "",
      docRecord?.mime || "",
      docRecord?.dataUrl || "",
    );
  })();
  parentAuth.issued(sessionToken, serialNo, downloadToken);
  rotate();
  return { ...cert, downloadToken };
}
function repairStoredCertificateUrls() {
  try {
    const activeBase = portalUrl();
    if (!activeBase || /^https?:\/\/(localhost|127\.0\.0\.1)\b/i.test(activeBase)) return;
    const rows = db
      .prepare(
        "SELECT serial_no, certificate_json FROM issued_logs WHERE certificate_json LIKE '%localhost%' OR certificate_json LIKE '%127.0.0.1%' OR certificate_json LIKE '%ais-dev-%'",
      )
      .all();
    const upd = db.prepare("UPDATE issued_logs SET certificate_json=? WHERE serial_no=?");
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.certificate_json);
        if (parsed && typeof parsed.verificationUrl === "string") {
          const u = new URL(parsed.verificationUrl);
          parsed.verificationUrl = `${activeBase}${u.pathname}${u.search}`;
          upd.run(JSON.stringify(parsed), r.serial_no);
        }
      } catch {}
    }
  } catch {}
}
repairStoredCertificateUrls();

async function decorate(cert, opts = {}) {
  let verificationUrl = cert.verificationUrl || "";
  if (cert.serialNo && cert.serialNo !== "PREVIEW") {
    const activeBase = normalizePortalUrl(opts.baseUrl || "") || portalUrl();
    if (!verificationUrl && activeBase) {
      verificationUrl = `${activeBase}/verify/${encodeURIComponent(cert.serialNo)}`;
    } else if (verificationUrl && activeBase) {
      try {
        const parsed = new URL(verificationUrl);
        const isStaleOrigin =
          parsed.hostname === "localhost" ||
          parsed.hostname === "127.0.0.1" ||
          parsed.hostname === "[::1]" ||
          /^ais-dev-/i.test(parsed.hostname);
        const hasConfiguredPublic = Boolean(
          normalizePortalUrl(settings().public_url || "") || publicPortalEnv,
        );
        if (isStaleOrigin || hasConfiguredPublic) {
          verificationUrl = `${activeBase}${parsed.pathname}${parsed.search}`;
        }
      } catch {}
    }
  }
  if (cert.docSignature && verificationUrl && !verificationUrl.includes("v=")) {
    verificationUrl += `${verificationUrl.includes("?") ? "&" : "?"}v=${encodeURIComponent(cert.docSignature)}`;
  }
  let printMeta = null;
  if (
    cert.serialNo &&
    cert.serialNo !== "PREVIEW" &&
    opts.copyNumber === undefined &&
    !opts.isVerificationPreview
  ) {
    printMeta = db
      .prepare("SELECT print_count, printer_name, is_guardian, last_print_code FROM issued_logs WHERE serial_no=?")
      .get(cert.serialNo);
  }
  const copyNumber =
    opts.copyNumber !== undefined
      ? Number(opts.copyNumber || 0)
      : opts.isVerificationPreview
        ? 0
        : Number(printMeta?.print_count || 0);
  const printerName =
    opts.printerName !== undefined
      ? opts.printerName
      : printMeta?.printer_name || cert.printerName || "";
  const collectorLabel =
    opts.collectorLabel !== undefined
      ? opts.collectorLabel
      : cert.collectorLabel ||
        (printMeta
          ? printMeta.is_guardian
            ? "Authorized Guardian"
            : "Parent / Family Collector"
          : "");
  const copySeal =
    cert.serialNo && cert.serialNo !== "PREVIEW"
      ? computePrintCopySeal(
          settings().verification_secret || "rjc-default-verify-secret",
          {
            serialNo: cert.serialNo,
            copyNumber: Math.max(1, copyNumber || 1),
            docSignature: cert.docSignature || "",
          },
        )
      : null;
  const printSecurityCode =
    opts.printSecurityCode ||
    printMeta?.last_print_code ||
    (copySeal ? copySeal.printSecurityCode : "");
  const printToken = opts.printToken || (copySeal ? copySeal.printToken : "");
  const pageNo =
    opts.pageNo ||
    (copyNumber
      ? `Page 1 of 1 (Sheet #${String(copyNumber).padStart(2, "0")})`
      : "Page 1 of 1");
  if (
    !opts.isVerificationPreview &&
    printToken &&
    verificationUrl &&
    !verificationUrl.includes("p=")
  ) {
    verificationUrl += `${verificationUrl.includes("?") ? "&" : "?"}p=${encodeURIComponent(printToken)}`;
  }
  return {
    ...cert,
    verificationUrl,
    copyNumber,
    printerName,
    collectorLabel,
    printSecurityCode,
    pageNo,
    ...renderCertificate({
      ...cert,
      copyNumber,
      printerName,
      collectorLabel,
      printSecurityCode,
      pageNo,
      verificationUrl,
      verificationQr: await qr(verificationUrl),
    }),
  };
}
const approvalService = createApprovalService({
  db,
  clean,
  esc,
  safeSettings,
  portalUrl,
  verificationSecret: () => settings().verification_secret || "",
});
const printQueue = createPrintQueue({ db, settings, decorate, pdf });
const generatePdfForRequest = async (reqRow) => {
  if (!reqRow?.serial_no) return null;
  const logRow = db
    .prepare("SELECT certificate_json FROM issued_logs WHERE serial_no=?")
    .get(reqRow.serial_no);
  if (!logRow?.certificate_json) return null;
  const cert = await decorate(JSON.parse(logRow.certificate_json));
  return await pdf(cert.certificateHtml);
};
const notifyService = createNotifyService({ db, settings, portalUrl });
const telegramBot = createTelegramBot({
  db,
  settings,
  approvalService,
  portalUrl,
  hashPassword,
  generatePdfForRequest,
  onApproved: async (res) => {
    await printQueue.onRequestApproved(res.request.id);
    telegramBot.sendApprovedArchive(res.request).catch(() => {});
    notifyService.notifyParentOnApproval(res.request).catch(() => {});
  },
});
telegramBot.start();

app.post("/api/parent/submit-request", requireParent, async (req, res) => {
  const b = req.body || {};
  const session = req.parentSession;
  const sessToken = parentToken(req);
  if (b.isLocalKiosk === true) {
    fail("Direct local kiosk bypass is disabled.", 403);
  }
  if (!session.faceVerified || !session.facePhotoData) {
    fail("Live face photo proof is required before submitting.", 403);
  }
  if (session.requestId) {
    fail("A request has already been submitted in this session.", 409);
  }
  const suppliedCampusCode = String(b.campusCode ?? "").trim();
  if (
    suppliedCampusCode !== "" &&
    (Date.now() >= campus.expiresAt || suppliedCampusCode !== campus.code)
  ) {
    fail("Campus code is invalid or expired. Check the school monitor.", 403);
  }
  const gr = session.refs.get(String(b.studentRef || ""));
  if (!gr) fail("Verification required.", 403);
  const student = db
    .prepare("SELECT * FROM students WHERE gr_number=? AND status='ACTIVE'")
    .get(gr);
  if (!student) fail("Verification required.", 403);
  const tpl = db
    .prepare("SELECT * FROM document_templates WHERE id=? AND is_active=1")
    .get(Number(b.templateId) || 0);
  if (!tpl) fail("Document template is unavailable.", 404);

  let guardianPhone = "";
  if (session.method === "staff") guardianPhone = session.guardianPhone;
  else if (b.isGuardian === true) {
    if (session.method !== "otp" || !/^\d{10}$/.test(String(b.guardianPhone || ""))) {
      fail("Guardian approval is required.", 403);
    }
    guardianPhone = String(b.guardianPhone);
  }

  let docRecord = null;
  if (typeof b.uploadToken === "string" && b.uploadToken.trim()) {
    pruneUploads();
    const entry = bonafideUploads.get(b.uploadToken.trim());
    if (
      entry &&
      entry.sessionToken === sessToken &&
      entry.grNumber === student.gr_number &&
      entry.file
    ) {
      docRecord = entry.file;
      bonafideUploads.delete(b.uploadToken.trim());
    }
  }

  const reqRow = approvalService.createRequest({
    student,
    tpl,
    lang: b.lang,
    verifiedPhone: guardianPhone || session.phone,
    authMethod: session.method,
    isGuardian: Boolean(guardianPhone),
    guardianPhone,
    parentPhotoData: session.facePhotoData,
    supportingDoc: docRecord,
    reason: typeof b.reason === "string" ? b.reason.trim().slice(0, 200) : "",
    campusCodeUsed: String(b.campusCode || "").trim().slice(0, 16),
  });
  parentAuth.setPendingRequest(sessToken, reqRow.id);
  rotate();
  telegramBot.sendRequestNotifications(reqRow).catch(() => {});

  res.json({
    requestId: reqRow.id,
    status: reqRow.status,
    studentName: reqRow.student_name,
    docTitle: reqRow.doc_title,
    createdAt: reqRow.created_at,
  });
});

app.get("/api/parent/request-status/:id", requireParent, (req, res) => {
  const id = String(req.params.id || "");
  if (!req.parentSession.requestId || req.parentSession.requestId !== id) {
    fail("Request not found for this session.", 403);
  }
  const row = db
    .prepare(
      `SELECT id, student_name, doc_title, status, reviewed_by_name, reviewed_by_role,
        review_channel, rejection_reason, serial_no, print_status, print_error,
        print_count, last_print_code, printer_name,
        created_at, reviewed_at, printed_at
       FROM approval_requests WHERE id=?`,
    )
    .get(id);
  if (!row) fail("Request not found.", 404);
  const printCount = Number(row.print_count || 0);
  const copyLabel =
    printCount <= 0
      ? "UNPRINTED"
      : printCount === 1
        ? "ORIGINAL"
        : `DUPLICATE #${printCount}`;
  const pageNo =
    printCount > 0
      ? `Page 1 of 1 (Sheet #${String(printCount).padStart(2, "0")})`
      : "";
  res.json({
    id: row.id,
    studentName: row.student_name,
    docTitle: row.doc_title,
    status: row.status,
    reviewedByName: row.reviewed_by_name,
    reviewedByRole: row.reviewed_by_role,
    reviewChannel: row.review_channel,
    rejectionReason: row.rejection_reason,
    serialNo: row.serial_no,
    printStatus: row.print_status,
    printError: row.print_error,
    printCount,
    copyLabel,
    pageNo,
    lastPrintCode: row.last_print_code || "",
    printerName: row.printer_name || "",
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    printedAt: row.printed_at,
  });
});

// Parents cannot generate/download documents directly without teacher approval
app.post("/api/generate-document", requireParent, (req, res) => {
  fail("Direct certificate release is disabled. Submit your request for teacher approval.", 403);
});
app.get("/api/documents/:serial/pdf", requireAdmin, async (req, res) => {
  const row = db
    .prepare("SELECT certificate_json FROM issued_logs WHERE serial_no=?")
    .get(req.params.serial);
  if (!row?.certificate_json) fail("Document not found.", 404);
  const c = await decorate(JSON.parse(row.certificate_json));
  res
    .set("Content-Disposition", `attachment; filename="${req.params.serial}.pdf"`)
    .type("pdf")
    .send(await pdf(c.certificateHtml));
});

// Connected School PC Kiosk Print Watcher (counter-local only)
app.get("/api/kiosk/print-next", async (req, res) => {
  if (!canAccessLocalCounter(req) || isMobileParentSession(req)) {
    return res.status(403).json({ error: "Counter access required." });
  }
  const job = await printQueue.getNextBrowserJob();
  res.json({ job });
});
app.post("/api/kiosk/print-ack/:id", (req, res) => {
  if (!canAccessLocalCounter(req) || isMobileParentSession(req)) {
    return res.status(403).json({ error: "Counter access required." });
  }
  printQueue.acknowledgeBrowserPrint(
    String(req.params.id || ""),
    req.body?.ok !== false,
    req.body?.error || "",
  );
  res.json({ ok: true });
});

// Teacher Mobile Portal Routes
app.get(["/teacher", "/teacher.html"], (req, res) =>
  res.sendFile(path.join(__dirname, "public", "teacher.html")),
);
app.get("/api/teacher/roster", (req, res) => {
  const teachers = db
    .prepare(
      "SELECT id, name, role, is_top_teacher FROM teachers WHERE is_active=1 AND COALESCE(pin_hash,'')!='' ORDER BY is_top_teacher DESC, slot_number ASC, name ASC",
    )
    .all();
  res.json({
    schoolName: settings().school_name,
    teachers,
  });
});
app.post(
  "/api/teacher/login",
  rateLimit({
    windowMs: 900000,
    limit: 30,
    message: { error: "Too many login attempts. Wait 15 minutes." },
  }),
  (req, res) => {
    const teacherId = Number(req.body.teacherId);
    const pin = String(req.body.pin || "").trim();
    const teacher = db
      .prepare("SELECT * FROM teachers WHERE id=? AND is_active=1")
      .get(teacherId);
    if (!teacher || !teacher.pin_hash || !checkPassword(pin, teacher.pin_hash)) {
      fail("Invalid teacher PIN.", 401);
    }
    const token = crypto.randomBytes(32).toString("hex");
    teacherTokens.set(token, {
      teacherId: teacher.id,
      expiresAt: Date.now() + 12 * 3600000,
    });
    res.json({
      token,
      teacher: {
        id: teacher.id,
        name: teacher.name,
        role: teacher.role,
        is_top_teacher: teacher.is_top_teacher,
      },
    });
  },
);
app.post("/api/teacher/logout", (req, res) => {
  const t = String(req.headers["x-teacher-token"] || "");
  if (t) teacherTokens.delete(t);
  res.json({ ok: true });
});
app.get("/api/teacher/requests", requireTeacher, (req, res) => {
  const requests = db
    .prepare(
      `SELECT r.id, r.gr_number, r.student_name, r.doc_title, r.lang, r.verified_phone,
        r.is_guardian, r.guardian_phone, r.parent_photo_data, r.supporting_doc_name,
        r.supporting_doc_mime, r.reason, r.campus_code_used,
        r.print_count, r.printer_name, r.printed_by_name,
        (CASE WHEN COALESCE(r.supporting_doc_data,'')!='' THEN 1 ELSE 0 END) AS has_supporting_doc,
        r.status, r.reviewed_by_name, r.reviewed_by_role, r.review_channel,
        r.rejection_reason, r.serial_no, r.print_status, r.print_error,
        r.notification_status, r.notified_at,
        r.created_at, r.reviewed_at, r.printed_at,
        COALESCE(st.photo_data, '') AS student_photo_data,
        COALESCE(st.parent_phone, '') AS student_phone,
        COALESCE(tpl.require_top_teacher, 0) AS require_top_teacher
       FROM approval_requests r
       LEFT JOIN students st ON st.gr_number = r.gr_number
       LEFT JOIN document_templates tpl ON tpl.id = r.template_id
       ORDER BY r.created_at DESC
       LIMIT 100`,
    )
    .all();
  res.json({ teacher: req.teacher, requests });
});
app.get("/api/teacher/requests/:id/attachment", requireTeacher, (req, res) => {
  const row = db
    .prepare(
      "SELECT supporting_doc_name, supporting_doc_mime, supporting_doc_data FROM approval_requests WHERE id=?",
    )
    .get(String(req.params.id || ""));
  if (!row?.supporting_doc_data) fail("No application attached.", 404);
  const match = /^data:([^;]+);base64,(.+)$/.exec(row.supporting_doc_data);
  if (!match) fail("Attachment unavailable.", 404);
  const bytes = Buffer.from(match[2], "base64");
  const safeName =
    String(row.supporting_doc_name || "application")
      .replace(/["\\\r\n]/g, "_")
      .trim() || "application";
  res
    .set("Content-Disposition", `inline; filename="${safeName}"`)
    .type(row.supporting_doc_mime || match[1])
    .send(bytes);
});
app.post("/api/teacher/requests/:id/approve", requireTeacher, async (req, res) => {
  const result = approvalService.approveRequest({
    requestId: String(req.params.id || ""),
    teacher: req.teacher,
    channel: "web",
  });
  if (result.notFound) fail("Request not found.", 404);
  if (result.forbiddenTopOnly) {
    fail("Only Top Teachers (Slot 1–3) can approve this sensitive document.", 403);
  }
  if (!result.alreadyHandled) {
    telegramBot.syncReviewedMessages(result.request).catch(() => {});
    await printQueue.onRequestApproved(result.request.id);
    telegramBot.sendApprovedArchive(result.request).catch(() => {});
    notifyService.notifyParentOnApproval(result.request).catch(() => {});
  }
  res.json({
    ok: true,
    alreadyHandled: Boolean(result.alreadyHandled),
    request: db
      .prepare(
        "SELECT id, status, reviewed_by_name, reviewed_by_role, serial_no, print_status, notification_status FROM approval_requests WHERE id=?",
      )
      .get(result.request.id),
  });
});
app.post("/api/teacher/requests/:id/release-print", requireTeacher, async (req, res) => {
  const row = await printQueue.releaseStaffPrint(
    String(req.params.id || ""),
    req.teacher?.name || "",
  );
  if (!row) fail("Approved request not found.", 404);
  telegramBot.syncReviewedMessages(row).catch(() => {});
  res.json({ ok: true, request: row });
});
app.post("/api/teacher/requests/:id/reject", requireTeacher, async (req, res) => {
  const reason = String(req.body?.reason || "Declined by teacher.")
    .trim()
    .slice(0, 240);
  const result = approvalService.rejectRequest({
    requestId: String(req.params.id || ""),
    teacher: req.teacher,
    channel: "web",
    reason,
  });
  if (result.notFound) fail("Request not found.", 404);
  if (!result.alreadyHandled) {
    telegramBot.syncReviewedMessages(result.request).catch(() => {});
  }
  res.json({
    ok: true,
    alreadyHandled: Boolean(result.alreadyHandled),
    request: db
      .prepare(
        "SELECT id, status, reviewed_by_name, reviewed_by_role, rejection_reason FROM approval_requests WHERE id=?",
      )
      .get(result.request.id),
  });
});

function istYmd(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Front Panel Staff & Admin Daily Applications Queue Routes
app.get("/api/counter/requests", requireStaffOrAdmin, (req, res) => {
  const todayIst = istYmd();
  const scope = String(req.query.scope || "today");
  const yearParam = String(req.query.year || "").trim();
  const monthParam = String(req.query.month || "").trim();
  const qParam = String(req.query.q || "").trim().toLocaleLowerCase();
  const rows = db
    .prepare(
      `SELECT r.id, r.gr_number, r.student_name, r.doc_title, r.lang, r.verified_phone,
        r.is_guardian, r.guardian_phone, r.parent_photo_data, r.supporting_doc_name,
        r.supporting_doc_mime, r.reason, r.campus_code_used,
        r.print_count, r.printer_name, r.printed_by_name,
        COALESCE(r.last_print_code, il.last_print_code, '') AS last_print_code,
        (CASE WHEN COALESCE(r.supporting_doc_data,'')!='' THEN 1 ELSE 0 END) AS has_supporting_doc,
        r.status, r.reviewed_by_name, r.reviewed_by_role, r.review_channel,
        r.rejection_reason, r.serial_no, r.print_status, r.print_error,
        r.notification_status, r.notified_at,
        r.created_at, r.reviewed_at, r.printed_at,
        COALESCE(st.class_name, '') AS class_name,
        COALESCE(st.division, '') AS division,
        COALESCE(tpl.require_top_teacher, 0) AS require_top_teacher,
        COALESCE(il.doc_signature, '') AS doc_signature,
        COALESCE(il.security_code, '') AS security_code
       FROM approval_requests r
       LEFT JOIN students st ON st.gr_number = r.gr_number
       LEFT JOIN document_templates tpl ON tpl.id = r.template_id
       LEFT JOIN issued_logs il ON il.serial_no = r.serial_no AND r.serial_no != ''
       ORDER BY r.created_at DESC
       LIMIT 500`,
    )
    .all()
    .map((r) => {
      const ymd = istYmd(r.created_at);
      const isToday = ymd === todayIst;
      const sigPart = r.doc_signature ? `?v=${encodeURIComponent(r.doc_signature)}` : "";
      const printCount = Number(r.print_count || 0);
      let printCode = r.last_print_code || "";
      if (!printCode && r.serial_no && printCount > 0) {
        try {
          printCode = computePrintCopySeal(
            settings().verification_secret || "rjc-default-verify-secret",
            {
              serialNo: r.serial_no,
              copyNumber: printCount,
              docSignature: r.doc_signature || "",
            },
          ).printSecurityCode;
        } catch {}
      }
      return {
        ...r,
        print_count: printCount,
        last_print_code: printCode,
        page_no:
          printCount > 0
            ? `Page 1 of 1 (Sheet #${String(printCount).padStart(2, "0")})`
            : "Page 1 of 1",
        copy_label: printCount === 0 ? "" : printCount === 1 ? "ORIGINAL" : `DUPLICATE #${printCount}`,
        collector_label: r.is_guardian
          ? "Authorized Guardian (Counter-Verified Collector)"
          : "Parent / Family Collector",
        created_ymd: ymd,
        created_year: ymd ? ymd.slice(0, 4) : "",
        created_month: ymd ? ymd.slice(5, 7) : "",
        is_today: isToday,
        verification_url: r.serial_no ? `/verify/${encodeURIComponent(r.serial_no)}${sigPart}` : "",
      };
    });

  const years = [...new Set(rows.map((r) => r.created_year).filter(Boolean))].sort((a, b) =>
    b.localeCompare(a),
  );
  const currentYear = todayIst.slice(0, 4);
  if (currentYear && !years.includes(currentYear)) years.unshift(currentYear);

  const todayRows = rows.filter((r) => r.is_today);
  const summary = {
    dateIst: todayIst,
    totalToday: todayRows.length,
    pendingToday: todayRows.filter((r) => r.status === "PENDING").length,
    approvedToday: todayRows.filter((r) => r.status === "APPROVED").length,
    printedToday: todayRows.filter((r) => r.status === "APPROVED" && r.print_status === "PRINTED").length,
    rejectedToday: todayRows.filter((r) => r.status === "REJECTED").length,
    openPendingAll: rows.filter((r) => r.status === "PENDING").length,
    holdPrintAll: rows.filter((r) => r.status === "APPROVED" && r.print_status === "HOLD_STAFF").length,
    totalAll: rows.length,
  };

  const hasHistoryFilter =
    scope === "all" ||
    (/^\d{4}$/.test(yearParam) && yearParam !== "all") ||
    (/^\d{2}$/.test(monthParam) && monthParam !== "all") ||
    Boolean(qParam);

  let filtered = hasHistoryFilter
    ? rows
    : rows.filter((r) => r.is_today || r.status === "PENDING" || r.print_status === "HOLD_STAFF");

  if (/^\d{4}$/.test(yearParam)) {
    filtered = filtered.filter((r) => r.created_year === yearParam);
  }
  if (/^\d{2}$/.test(monthParam)) {
    filtered = filtered.filter((r) => r.created_month === monthParam);
  }
  if (qParam) {
    filtered = filtered.filter((r) =>
      [
        r.student_name,
        r.gr_number,
        r.doc_title,
        r.serial_no,
        r.id,
        r.reviewed_by_name,
        r.reason,
        r.security_code,
        r.last_print_code,
        r.verified_phone,
      ].some((v) => String(v || "").toLocaleLowerCase().includes(qParam)),
    );
  }

  res.json({
    actor: req.staffActor,
    summary,
    years,
    requests: filtered,
  });
});

app.get("/api/counter/requests/:id/attachment", requireStaffOrAdmin, (req, res) => {
  const row = db
    .prepare(
      "SELECT supporting_doc_name, supporting_doc_mime, supporting_doc_data FROM approval_requests WHERE id=?",
    )
    .get(String(req.params.id || ""));
  if (!row?.supporting_doc_data) fail("No application attached.", 404);
  const match = /^data:([^;]+);base64,(.+)$/.exec(row.supporting_doc_data);
  if (!match) fail("Attachment unavailable.", 404);
  const bytes = Buffer.from(match[2], "base64");
  const safeName =
    String(row.supporting_doc_name || "application")
      .replace(/["\\\r\n]/g, "_")
      .trim() || "application";
  res
    .set("Content-Disposition", `inline; filename="${safeName}"`)
    .type(row.supporting_doc_mime || match[1])
    .send(bytes);
});

app.post("/api/counter/requests/:id/approve", requireStaffOrAdmin, async (req, res) => {
  const result = approvalService.approveRequest({
    requestId: String(req.params.id || ""),
    teacher: req.staffActor,
    channel: req.staffActor.isAdmin ? "admin-desk" : "counter-desk",
  });
  if (result.notFound) fail("Request not found.", 404);
  if (result.forbiddenTopOnly) {
    fail("Only Top Teachers (Slot 1–3) or Admin can approve this sensitive document.", 403);
  }
  if (!result.alreadyHandled) {
    telegramBot.syncReviewedMessages(result.request).catch(() => {});
    await printQueue.onRequestApproved(result.request.id);
    telegramBot.sendApprovedArchive(result.request).catch(() => {});
    notifyService.notifyParentOnApproval(result.request).catch(() => {});
  }
  res.json({
    ok: true,
    alreadyHandled: Boolean(result.alreadyHandled),
    request: db
      .prepare(
        "SELECT id, status, reviewed_by_name, reviewed_by_role, serial_no, print_status, notification_status FROM approval_requests WHERE id=?",
      )
      .get(result.request.id),
  });
});

app.post("/api/counter/requests/:id/reject", requireStaffOrAdmin, async (req, res) => {
  const reason = String(req.body?.reason || "Declined at school counter.")
    .trim()
    .slice(0, 240);
  const result = approvalService.rejectRequest({
    requestId: String(req.params.id || ""),
    teacher: req.staffActor,
    channel: req.staffActor.isAdmin ? "admin-desk" : "counter-desk",
    reason,
  });
  if (result.notFound) fail("Request not found.", 404);
  if (!result.alreadyHandled) {
    telegramBot.syncReviewedMessages(result.request).catch(() => {});
  }
  res.json({
    ok: true,
    alreadyHandled: Boolean(result.alreadyHandled),
    request: db
      .prepare(
        "SELECT id, status, reviewed_by_name, reviewed_by_role, rejection_reason FROM approval_requests WHERE id=?",
      )
      .get(result.request.id),
  });
});

app.post("/api/counter/requests/:id/release-print", requireStaffOrAdmin, async (req, res) => {
  const row = await printQueue.releaseStaffPrint(
    String(req.params.id || ""),
    req.staffActor?.name || "",
  );
  if (!row) fail("Approved request not found.", 404);
  telegramBot.syncReviewedMessages(row).catch(() => {});
  res.json({ ok: true, request: row });
});

app.post("/api/counter/requests/:id/reprint", requireStaffOrAdmin, async (req, res) => {
  const row = await printQueue.requeuePrint(
    String(req.params.id || ""),
    req.staffActor?.name || "",
  );
  if (!row) fail("Approved request not found.", 404);
  res.json({ ok: true, request: row });
});

app.get("/verify/:serial", async (req, res) => {
  const serial = String(req.params.serial || "").trim();
  const existing = db
    .prepare(
      `SELECT serial_no, gr_number, student_name, doc_title, issued_at,
        is_guardian, approved_by_name, approved_by_role, parent_photo_data,
        supporting_doc_name, reason, campus_code_used,
        COALESCE(print_count, 0) AS print_count, printer_name, printed_by_name, last_printed_at,
        COALESCE(last_print_code, '') AS last_print_code,
        scan_count, last_scanned_at,
        certificate_json, doc_signature, security_code
       FROM issued_logs WHERE serial_no=?`,
    )
    .get(serial);

  const suppliedSig = String(req.query.v || "").trim();
  const suppliedPrintToken = String(req.query.p || "").trim();
  const suppliedPrintCode = String(req.query.code || "").trim().toUpperCase();
  let sealState = { hasSig: Boolean(suppliedSig), valid: false, expectedSig: "", securityCode: "", contentHash: "" };
  let parsedCert = null;

  if (existing) {
    if (existing.certificate_json) {
      try {
        parsedCert = JSON.parse(existing.certificate_json);
      } catch {}
    }
    const secret = settings().verification_secret || "";
    if (parsedCert && secret) {
      const check = verifyVerificationSeal(
        secret,
        {
          serialNo: parsedCert.serialNo || existing.serial_no,
          grNumber: parsedCert.student?.gr_number || existing.gr_number,
          studentName: parsedCert.student?.full_name || existing.student_name,
          docTitle: parsedCert.docTitle || existing.doc_title,
          issuedAt: parsedCert.issuedAt || formatIstDateTime(existing.issued_at),
          bodyHtml: parsedCert.bodyHtml || "",
        },
        suppliedSig,
      );
      sealState = {
        hasSig: check.hasSig,
        valid: check.valid || (Boolean(suppliedSig) && Boolean(existing.doc_signature) && suppliedSig === existing.doc_signature),
        expectedSig: existing.doc_signature || check.expected.sig,
        securityCode: existing.security_code || parsedCert.securityCode || check.expected.securityCode,
        contentHash: parsedCert.contentHash || check.expected.contentHash,
      };
    } else if (existing.doc_signature) {
      sealState = {
        hasSig: Boolean(suppliedSig),
        valid: Boolean(suppliedSig && suppliedSig === existing.doc_signature),
        expectedSig: existing.doc_signature,
        securityCode: existing.security_code || "",
        contentHash: parsedCert?.contentHash || "",
      };
    }
  }

  if (existing && sealState.hasSig && !sealState.valid) {
    return res
      .status(403)
      .type("html")
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RJC · Verification Warning</title><style>*{box-sizing:border-box}body{margin:0;min-height:100dvh;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f3f2ee;color:#141414;padding:6vh 5vw}.sheet{max-width:620px;margin:auto;background:#faf9f6;border:1px solid #a32620;border-top:5px solid #a32620;padding:28px}.eyebrow{font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#a32620;margin:0 0 10px}h1{font-weight:500;font-size:24px;margin:0 0 12px;color:#a32620}p{margin:0;color:#141414}</style><main class="sheet"><p class="eyebrow">RJC · SECURITY WARNING</p><h1>Invalid or tampered verification QR</h1><p>The digital security signature on this QR link does not match the school office record for <strong>${esc(serial)}</strong>. Do not trust altered copies — contact the school office directly to verify.</p></main></html>`,
      );
  }

  function buildCompletePrintHistory({
    serialNo,
    printCount,
    docSig,
    fallbackPrinter,
    fallbackTime,
    verifySecret,
  }) {
    const rawRows = db
      .prepare(
        "SELECT id, copy_number, copy_label, printer_name, printed_by_name, printed_at, COALESCE(page_no, '') AS page_no, COALESCE(print_token, '') AS print_token, COALESCE(print_security_code, '') AS print_security_code FROM print_logs WHERE serial_no=? ORDER BY copy_number ASC, id ASC LIMIT 100",
      )
      .all(serialNo);
    const byCopy = new Map();
    for (const r of rawRows) {
      byCopy.set(Number(r.copy_number || 1), r);
    }
    const maxCopy = Math.max(
      Number(printCount || 0),
      byCopy.size ? Math.max(...byCopy.keys()) : 0,
    );
    const out = [];
    for (let cNum = 1; cNum <= maxCopy; cNum++) {
      const existingRow = byCopy.get(cNum);
      const derived = computePrintCopySeal(verifySecret, {
        serialNo,
        copyNumber: cNum,
        docSignature: docSig || "",
      });
      const rawPageNo = existingRow?.page_no || "";
      const normalizedPageNo =
        rawPageNo && rawPageNo.includes("Sheet #")
          ? rawPageNo
          : derived.pageNo;
      const printedAtIso = existingRow?.printed_at || fallbackTime || "";
      out.push({
        id: existingRow?.id || cNum,
        copy_number: cNum,
        copy_label:
          existingRow?.copy_label || (cNum === 1 ? "ORIGINAL" : `DUPLICATE #${cNum}`),
        printer_name:
          existingRow?.printer_name || fallbackPrinter || "School Counter Printer",
        printed_by_name: existingRow?.printed_by_name || "School Office",
        printed_at: printedAtIso,
        page_no: normalizedPageNo,
        print_token: existingRow?.print_token || derived.printToken,
        print_security_code:
          existingRow?.print_security_code || derived.printSecurityCode,
        printed_display: formatIstDateTime(printedAtIso),
      });
    }
    return out;
  }

  const log = existing ? approvalService.recordQrScan(serial, req.get("user-agent") || "") : null;
  if (log) {
    telegramBot.sendQrScanAlert(log).catch(() => {});
  }
  const issuedDisplay = log ? formatIstDateTime(log.issued_at) : "";
  const scanDisplay = log?.last_scanned_at
    ? formatIstDateTime(log.last_scanned_at)
    : "";
  const collectorRoleText = log
    ? Number(log.is_guardian) === 1
      ? "Authorized Guardian (Counter-Verified Collector)"
      : "Parent / Family Collector"
    : "";
  const printCountNum = Number(log?.print_count || 0);
  const printStatusPrimary =
    printCountNum === 0
      ? "0 Sheets Printed (Pending Counter Print)"
      : printCountNum === 1
        ? "1 Physical Sheet · 1 Original Copy"
        : `${printCountNum} Physical Sheets · 1 Original + ${printCountNum - 1} Duplicate${printCountNum - 1 > 1 ? "s" : ""}`;
  const printStatusSub =
    printCountNum === 0
      ? "Approved · Waiting counter release"
      : `Latest: Sheet #${String(printCountNum).padStart(2, "0")} · ${log?.printer_name || "School Counter Printer"}`;

  const secret = settings().verification_secret || "rjc-default-verify-secret";
  const printRows = log
    ? buildCompletePrintHistory({
        serialNo: serial,
        printCount: printCountNum,
        docSig: sealState.expectedSig,
        fallbackPrinter: log.printer_name || "School Counter Printer",
        fallbackTime: log.last_printed_at || log.issued_at,
        verifySecret: secret,
      })
    : [];

  let matchedPrintSheet = null;
  if (log && (suppliedPrintToken || suppliedPrintCode)) {
    matchedPrintSheet =
      printRows.find(
        (p) =>
          (suppliedPrintToken && p.print_token === suppliedPrintToken) ||
          (suppliedPrintCode && p.print_security_code.toUpperCase() === suppliedPrintCode),
      ) || null;
    if (!matchedPrintSheet) {
      for (let cNum = 1; cNum <= Math.max(5, printCountNum + 1); cNum++) {
        const cand = computePrintCopySeal(secret, {
          serialNo: serial,
          copyNumber: cNum,
          docSignature: sealState.expectedSig,
        });
        if (
          (suppliedPrintToken && cand.printToken === suppliedPrintToken) ||
          (suppliedPrintCode && cand.printSecurityCode.toUpperCase() === suppliedPrintCode)
        ) {
          matchedPrintSheet = {
            copy_number: cNum,
            copy_label: cNum === 1 ? "ORIGINAL" : `DUPLICATE #${cNum}`,
            page_no: cand.pageNo,
            print_security_code: cand.printSecurityCode,
            printer_name: log.printer_name || "School Counter Printer",
          };
          break;
        }
      }
    }
  }

  const defaultCopySeal = log
    ? computePrintCopySeal(secret, {
        serialNo: serial,
        copyNumber: Math.max(1, printCountNum || 1),
        docSignature: sealState.expectedSig,
      })
    : null;

  let originalDocHtml = "";
  let originalCertCss = "";
  if (log && parsedCert) {
    try {
      const decorated = await decorate(
        {
          ...parsedCert,
          securityCode: parsedCert.securityCode || sealState.securityCode,
          docSignature: parsedCert.docSignature || sealState.expectedSig,
        },
        {
          isVerificationPreview: true,
          collectorLabel: Number(log.is_guardian) === 1 ? "Authorized Guardian" : "Parent / Family Collector",
          printerName: log.printer_name || "",
          printSecurityCode:
            matchedPrintSheet?.print_security_code ||
            log.last_print_code ||
            defaultCopySeal?.printSecurityCode ||
            "",
          pageNo:
            matchedPrintSheet?.page_no ||
            defaultCopySeal?.pageNo ||
            "Page 1 of 1",
        },
      );
      originalDocHtml = decorated.certificateBody || "";
      originalCertCss = decorated.certificateCss || "";
    } catch {}
  }

  const sealBanner = log
    ? sealState.valid
      ? `<div class="seal-banner valid"><strong>✓ CRYPTOGRAPHIC SEAL VERIFIED</strong><span>Original school record unlocked — compare every word below against the printed paper.${sealState.securityCode ? ` · Seal: <code class="nb">${esc(sealState.securityCode)}</code>` : ""}${matchedPrintSheet ? ` · Sheet Verified: <code class="nb">${esc(matchedPrintSheet.copy_label)} (${esc(matchedPrintSheet.print_security_code)})</code>` : defaultCopySeal ? ` · Print 2FA Code: <code class="nb">${esc(defaultCopySeal.printSecurityCode)}</code>` : ""}${sealState.contentHash ? ` · Hash: <code class="nb">${esc(sealState.contentHash)}</code>` : ""}</span></div>`
      : `<div class="seal-banner neutral"><strong>DIRECT SERIAL LOOKUP</strong><span>This record matches school logs. Scan the QR printed on the paper certificate to verify its cryptographic seal.${sealState.securityCode ? ` · Seal: <code class="nb">${esc(sealState.securityCode)}</code>` : ""}</span></div>`
    : "";

  const printSheetTableHtml = log
    ? `<section class="db-crosscheck no-print"><div class="db-crosscheck-head"><div><h2>2FA Printer &amp; Page Cross-Check (School Database)</h2><p>Every physical sheet printed at the school counter is assigned a unique encrypted Print 2FA Code and Page/Sheet Number in the bottom border window.${printRows.length > 3 ? ` Scroll the table below to inspect all ${printRows.length} printed copies.` : ""}</p></div><form class="code-check-form" method="get" action="/verify/${encodeURIComponent(serial)}">${suppliedSig ? `<input type="hidden" name="v" value="${esc(suppliedSig)}">` : ""}<input type="text" name="code" placeholder="Print 2FA Code (e.g. ${esc(defaultCopySeal?.printSecurityCode || "PRT-01-XXXX")})" value="${esc(suppliedPrintCode)}"><button type="submit" class="print-btn">Cross-Check Sheet Code</button></form></div>${
         (suppliedPrintCode || suppliedPrintToken)
          ? matchedPrintSheet
            ? `<div class="sheet-match ok"><strong>✓ AUTHENTIC PRINT SHEET MATCHED:</strong> Copy #${esc(String(matchedPrintSheet.copy_number))} (${esc(matchedPrintSheet.copy_label)}) · ${esc(matchedPrintSheet.page_no)} · Print 2FA Code: <code>${esc(matchedPrintSheet.print_security_code)}</code></div>`
            : `<div class="sheet-match bad"><strong>✕ UNRECOGNIZED PRINT 2FA CODE:</strong> The entered code does not match any physical sheet printed by the school printer for ${esc(serial)}.</div>`
          : ""
      }${
        printRows.length
          ? `<div class="sheet-table-wrap" role="region" aria-label="Printed copies cross-check table" tabindex="0"><table class="sheet-table"><thead><tr><th>Copy #</th><th>Status</th><th>Page / Sheet No.</th><th>Print 2FA Code (Bottom Border Box)</th><th>Printer</th><th>Printed At</th></tr></thead><tbody>${printRows
              .map(
                (p) =>
                  `<tr><td><strong>#${esc(String(p.copy_number))}</strong></td><td><span class="tag ${p.copy_number === 1 ? "orig" : "dup"}">${esc(p.copy_label)}</span></td><td class="nb">${esc(p.page_no)}</td><td><code class="nb">${esc(p.print_security_code)}</code></td><td>${esc(p.printer_name || "School Counter Printer")}</td><td class="nb">${esc(p.printed_display)}</td></tr>`,
              )
              .join("")}</tbody></table></div>`
          : `<p class="sheet-empty">Expected First Print 2FA Code: <code class="nb">${esc(defaultCopySeal?.printSecurityCode || "")}</code> · Page: <strong>Page 1 of 1 (Sheet #01)</strong></p>`
      }</section>`
    : "";

  const scopedCertCss = originalCertCss
    ? originalCertCss
        .replace(/@page\{[^}]*\}/g, "")
        .replace(/@media screen\{body\{[^}]*\}\}/g, "")
        .replace(/\*\{box-sizing:border-box\}/g, "")
        .replace(/body\{[^}]*\}/g, "")
        .replace(/\.meta\{/g, ".doc-paper .meta{")
        .replace(/table\{/g, ".doc-paper table{")
        .replace(/td,th\{/g, ".doc-paper td,.doc-paper th{")
    : "";

  res
    .status(log ? 200 : 404)
    .type("html")
    .send(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RJC · Verify certificate</title><style>${scopedCertCss}*{box-sizing:border-box}body{margin:0;min-height:100dvh;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f3f2ee;color:#141414;padding:4vh 4vw}.sheet{max-width:880px;margin:auto;background:#faf9f6;border:1px solid #c8c7c0;border-top:4px solid #141414;padding:24px 26px}.eyebrow{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#5f5f59;margin:0 0 8px}h1{font-weight:400;font-size:26px;letter-spacing:-.02em;margin:0 0 14px;padding-bottom:12px;border-bottom:1px solid #c8c7c0}.nb{white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.seal-banner{border:1px solid #c8c7c0;padding:10px 14px;margin-bottom:16px;font-size:13px;display:flex;flex-direction:column;gap:2px}.seal-banner strong{font-family:ui-monospace,Menlo,monospace;font-size:12px;letter-spacing:.06em}.seal-banner.valid{border-color:#1b5e37;background:#e8f2ec;color:#143d25}.seal-banner.neutral{background:#f3f2ee;color:#3d3d39}.grid{display:grid;grid-template-columns:1fr;gap:18px;margin-bottom:18px}@media(min-width:640px){.grid.has-photo{grid-template-columns:160px minmax(0,1fr)}}.face-box{border:1px solid #c8c7c0;background:#fff;padding:6px;align-self:start}.face-box img{display:block;width:100%;height:170px;object-fit:cover}.face-cap{font-family:ui-monospace,Menlo,monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#141414;font-weight:600;margin-top:6px;text-align:center}.verify-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(195px,1fr));gap:12px 16px}.lbl{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:#5f5f59;margin-bottom:3px}.val{display:block;font-size:14.5px;line-height:1.4;font-weight:600;overflow-wrap:break-word}.sub-val{display:block;font-size:12px;font-weight:500;color:#5f5f59;margin-top:2px}.code-pill{display:inline-block;font-family:ui-monospace,Menlo,monospace;font-size:12px;font-weight:600;white-space:nowrap;background:#f3f2ee;border:1px solid #c8c7c0;padding:1px 6px;margin:1px 4px 1px 0}.db-crosscheck{margin-top:18px;padding:14px 16px;border:1px solid #141414;background:#f3f2ee}.db-crosscheck-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;margin-bottom:10px}.db-crosscheck-head h2{margin:0 0 4px;font-size:15px;font-weight:600}.db-crosscheck-head p{margin:0;font-size:12.5px;color:#5f5f59;max-width:440px}.code-check-form{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.code-check-form input{height:36px;padding:0 10px;border:1px solid #888780;background:#fff;font-family:ui-monospace,Menlo,monospace;font-size:12px;min-width:305px;text-transform:uppercase}.sheet-match{padding:8px 12px;margin-bottom:10px;font-size:12.5px;border:1px solid #c8c7c0}.sheet-match.ok{background:#e8f2ec;border-color:#1b5e37;color:#143d25}.sheet-match.bad{background:#fdf3f2;border-color:#a32620;color:#a32620}.sheet-table-wrap{max-height:215px;overflow-y:auto;overflow-x:auto;background:#fff;border:1px solid #c8c7c0;scrollbar-gutter:stable}.sheet-table{width:100%;border-collapse:collapse;font-size:12.5px}.sheet-table th,.sheet-table td{padding:7px 10px;border-bottom:1px solid #e2e1dc;text-align:left;vertical-align:middle}.sheet-table th{position:sticky;top:0;z-index:2;font-family:ui-monospace,Menlo,monospace;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:#5f5f59;background:#faf9f6;box-shadow:0 1px 0 #c8c7c0}.tag{display:inline-block;padding:2px 6px;font-family:ui-monospace,Menlo,monospace;font-size:10.5px;font-weight:700;white-space:nowrap;border:1px solid #141414}.tag.orig{background:#e8f2ec;border-color:#1b5e37;color:#143d25}.tag.dup{background:#fdf3f2;border-color:#a32620;color:#a32620}.sheet-empty{margin:4px 0 0;font-size:12.5px;color:#3d3d39}.doc-compare{margin-top:18px;padding-top:16px;border-top:2px solid #141414}.doc-compare-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}.doc-compare-head h2{margin:0;font-size:17px;font-weight:600}.doc-compare-sub{margin:0 0 12px;font-size:13px;color:#5f5f59}.doc-paper{background:#fff;border:1px solid #888780;padding:18px;overflow-x:auto;font-family:Noto,Arial,sans-serif;font-size:11pt;line-height:1.85;color:#17202b}.print-btn{cursor:pointer;border:1px solid #141414;background:#141414;color:#f3f2ee;font-family:ui-monospace,Menlo,monospace;font-size:12px;padding:8px 14px;height:36px}.note{margin:16px 0 0;padding-top:14px;border-top:1px solid #c8c7c0;font-size:13px;color:#5f5f59}@media print{body{background:#fff;padding:0}.sheet{border:0;padding:0;max-width:none}.no-print{display:none!important}.doc-paper{border:0;padding:0}}</style><main class="sheet"><p class="eyebrow">RJC · PERSONALIZED QR VERIFICATION</p><h1>${log ? "Verified school record" : "Record not found"}</h1>${sealBanner}${log ? `<div class="grid${log.parent_photo_data ? " has-photo" : ""}">${log.parent_photo_data ? `<div class="face-box"><img src="${esc(log.parent_photo_data)}" alt="Captured collector face proof"><div class="face-cap">${esc(collectorRoleText)}</div></div>` : ""}<div class="verify-meta"><div><span class="lbl">Student</span><span class="val">${esc(log.student_name)} (GR ${esc(log.gr_number)})</span></div><div><span class="lbl">Document</span><span class="val">${esc(log.doc_title)}</span></div><div><span class="lbl">Collector Role</span><span class="val">${esc(collectorRoleText)}</span></div><div><span class="lbl">Reference number</span><span class="val nb">${esc(log.serial_no)}</span></div><div><span class="lbl">Crypto Seal &amp; Print 2FA</span><span class="val"><span class="code-pill">${esc(sealState.securityCode || "VERIFIED")}</span><span class="code-pill">${esc(log.last_print_code || defaultCopySeal?.printSecurityCode || "")}</span></span></div><div><span class="lbl">Approved by</span><span class="val">${esc(log.approved_by_name || "School Office")}${log.approved_by_role ? `<span class="sub-val">${esc(log.approved_by_role)}</span>` : ""}</span></div><div><span class="lbl">Approved &amp; issued</span><span class="val">${esc(issuedDisplay)}</span></div><div><span class="lbl">Physical Prints</span><span class="val">${esc(printStatusPrimary)}<span class="sub-val">${esc(printStatusSub)}</span></span></div>${log.reason ? `<div><span class="lbl">Purpose / Reason</span><span class="val">${esc(log.reason)}</span></div>` : ""}<div><span class="lbl">Total QR scans</span><span class="val">${esc(String(log.scan_count || 1))} Scan${Number(log.scan_count || 1) === 1 ? "" : "s"}${scanDisplay ? `<span class="sub-val">Latest: ${esc(scanDisplay)}</span>` : ""}</span></div></div></div>${printSheetTableHtml}${originalDocHtml ? `<section class="doc-compare"><div class="doc-compare-head"><h2>Original Authentic Document (Locked Record)</h2><button type="button" class="print-btn no-print" onclick="window.print()">Print Verified Copy</button></div><p class="doc-compare-sub no-print">If any name, date, class, or wording on a paper copy differs from this original document, the paper copy has been tampered with. Only Print #1 issued at the school counter carries an ORIGINAL mark; reprints carry DUPLICATE.</p><div class="doc-paper">${originalDocHtml}</div></section>` : ""}<p class="note no-print">Every scan of this personalized QR code is logged in the school office database along with the approving teacher identity, collector role, and captured face proof.</p>` : '<p class="note">Check the reference number printed on the certificate or contact the school office.</p>'}</main></html>`,
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
app.get("/api/admin/dashboard", (req, res) => {
  const { verification_secret: _vs, ...adminSettings } = settings();
  const verifySecret = settings().verification_secret || "rjc-default-verify-secret";
  return res.json({
    settings: adminSettings,
    activePortalUrl: portalUrl(),
    students: db.prepare("SELECT * FROM students ORDER BY full_name").all(),
    templates: db.prepare("SELECT * FROM document_templates ORDER BY id").all(),
    teachers: db
      .prepare(
        "SELECT id, slot_number, name, role, is_top_teacher, telegram_chat_id, telegram_username, is_active, joined_via_bot, (CASE WHEN COALESCE(pin_hash,'')!='' THEN 1 ELSE 0 END) AS has_pin, created_at FROM teachers ORDER BY is_top_teacher DESC, CASE WHEN slot_number > 0 THEN slot_number ELSE 99 END ASC, id ASC",
      )
      .all(),
    requests: db
      .prepare(
        `SELECT r.id, r.gr_number, r.student_name, r.doc_title, r.status, r.reviewed_by_name,
          r.reviewed_by_role, r.review_channel, r.rejection_reason, r.serial_no, r.print_status,
          r.print_error, r.supporting_doc_name, r.verified_phone, r.guardian_phone, r.is_guardian,
          r.reason, r.campus_code_used, r.print_count, r.printer_name, r.printed_by_name,
          COALESCE(r.last_print_code, '') AS last_print_code,
          r.notification_status, r.notified_at,
          COALESCE(st.parent_phone, '') AS student_phone,
          COALESCE(tpl.require_top_teacher, 0) AS require_top_teacher,
          (CASE WHEN COALESCE(r.parent_photo_data,'')!='' THEN 1 ELSE 0 END) AS has_parent_photo,
          (CASE WHEN COALESCE(r.supporting_doc_data,'')!='' THEN 1 ELSE 0 END) AS has_supporting_doc,
          r.created_at, r.reviewed_at, r.printed_at
         FROM approval_requests r
         LEFT JOIN students st ON st.gr_number = r.gr_number
         LEFT JOIN document_templates tpl ON tpl.id = r.template_id
         ORDER BY r.created_at DESC LIMIT 120`,
      )
      .all(),
    logs: db
      .prepare(
        "SELECT serial_no,gr_number,student_name,doc_title,verified_phone,is_guardian,issued_at,COALESCE(issued_year, CAST(substr(issued_at,1,4) AS INTEGER)) AS issued_year,reason,supporting_doc_name,approved_by_name,approved_by_role,request_id,doc_signature,security_code,COALESCE(last_print_code,'') AS last_print_code,campus_code_used,COALESCE(print_count,0) AS print_count,printer_name,printed_by_name,last_printed_at,COALESCE(scan_count,0) AS scan_count,last_scanned_at,(CASE WHEN COALESCE(parent_photo_data,'')!='' THEN 1 ELSE 0 END) AS has_parent_photo,(CASE WHEN COALESCE(supporting_doc_data,'')!='' THEN 1 ELSE 0 END) AS has_supporting_doc FROM issued_logs ORDER BY issued_at DESC",
      )
      .all()
      .map((l) => {
        const pCount = Number(l.print_count || 0);
        let printCode = l.last_print_code || "";
        if (!printCode && l.serial_no) {
          try {
            printCode = computePrintCopySeal(verifySecret, {
              serialNo: l.serial_no,
              copyNumber: Math.max(1, pCount || 1),
              docSignature: l.doc_signature || "",
            }).printSecurityCode;
          } catch {}
        }
        return { ...l, last_print_code: printCode };
      }),
  });
});
app.get("/api/admin/logs/:serial/details", (req, res) => {
  const serial = String(req.params.serial || "");
  const verifySecret = settings().verification_secret || "rjc-default-verify-secret";
  const log = db
    .prepare(
      "SELECT serial_no, gr_number, student_name, doc_title, verified_phone, is_guardian, issued_at, issued_year, reason, campus_code_used, approved_by_name, approved_by_role, request_id, parent_photo_data, supporting_doc_name, security_code, doc_signature, COALESCE(last_print_code,'') AS last_print_code, COALESCE(print_count,0) AS print_count, printer_name, printed_by_name, last_printed_at, COALESCE(scan_count,0) AS scan_count, last_scanned_at FROM issued_logs WHERE serial_no=?",
    )
    .get(serial);
  if (!log) fail("Log entry not found.", 404);
  const studentRow = db
    .prepare("SELECT photo_data, parent_phone, parent_email FROM students WHERE gr_number=?")
    .get(log.gr_number);
  const scans = db
    .prepare(
      "SELECT id, scanned_at, source_hint FROM qr_scans WHERE serial_no=? ORDER BY id DESC LIMIT 50",
    )
    .all(serial);
  const rawPrints = db
    .prepare(
      "SELECT id, copy_number, copy_label, printer_name, printed_by_name, printed_at, COALESCE(page_no,'') AS page_no, COALESCE(print_token,'') AS print_token, COALESCE(print_security_code,'') AS print_security_code FROM print_logs WHERE serial_no=? ORDER BY copy_number ASC, id ASC LIMIT 100",
    )
    .all(serial);
  const byCopy = new Map();
  for (const p of rawPrints) byCopy.set(Number(p.copy_number || 1), p);
  const maxCopy = Math.max(
    Number(log.print_count || 0),
    byCopy.size ? Math.max(...byCopy.keys()) : 0,
  );
  const printHistory = [];
  for (let cNum = 1; cNum <= maxCopy; cNum++) {
    const existingRow = byCopy.get(cNum);
    const derived = computePrintCopySeal(verifySecret, {
      serialNo: serial,
      copyNumber: cNum,
      docSignature: log.doc_signature || "",
    });
    const rawPageNo = existingRow?.page_no || "";
    printHistory.push({
      id: existingRow?.id || cNum,
      copy_number: cNum,
      copy_label:
        existingRow?.copy_label || (cNum === 1 ? "ORIGINAL" : `DUPLICATE #${cNum}`),
      printer_name:
        existingRow?.printer_name || log.printer_name || "School Counter Printer",
      printed_by_name:
        existingRow?.printed_by_name || log.printed_by_name || "School Office",
      printed_at:
        existingRow?.printed_at || log.last_printed_at || log.issued_at,
      page_no:
        rawPageNo && rawPageNo.includes("Sheet #") ? rawPageNo : derived.pageNo,
      print_token: existingRow?.print_token || derived.printToken,
      print_security_code:
        existingRow?.print_security_code || derived.printSecurityCode,
    });
  }
  const reqRow = log.request_id
    ? db
        .prepare(
          "SELECT id, review_channel, print_status, print_count, printer_name, printed_by_name, reason, campus_code_used, notification_status, notified_at, created_at, reviewed_at, printed_at FROM approval_requests WHERE id=?",
        )
        .get(log.request_id)
    : null;
  const fallbackPrintCode =
    log.last_print_code ||
    printHistory[printHistory.length - 1]?.print_security_code ||
    computePrintCopySeal(verifySecret, {
      serialNo: serial,
      copyNumber: Math.max(1, Number(log.print_count || 1)),
      docSignature: log.doc_signature || "",
    }).printSecurityCode;
  res.json({
    log: {
      ...log,
      last_print_code: fallbackPrintCode,
      collector_label: log.is_guardian
        ? "Authorized Guardian (Counter-Verified Collector)"
        : "Parent / Family Collector",
      student_photo_data: studentRow?.photo_data || "",
      student_phone: studentRow?.parent_phone || "",
      student_email: studentRow?.parent_email || "",
    },
    scans,
    printHistory,
    request: reqRow,
  });
});
app.post("/api/admin/teachers", (req, res) => {
  const b = req.body || {};
  const id = Number(b.id) || 0;
  const name = text(b.name, "teacher name", 100, true);
  const role = text(b.role || (b.is_top_teacher ? "Top Teacher" : "Staff"), "role", 60, false) || "Staff";
  const isTop = b.is_top_teacher ? 1 : 0;
  const rawSlot = Number(b.slot_number);
  const slot = isTop
    ? rawSlot >= 1 && rawSlot <= 3
      ? rawSlot
      : 0
    : 0;
  const chatId = text(b.telegram_chat_id || "", "Telegram Chat ID", 64, false);
  const isActive = b.is_active === false || b.is_active === 0 ? 0 : 1;
  const pin = String(b.pin || "").trim();
  if (pin && !/^\d{4,8}$/.test(pin)) {
    fail("Teacher PIN must be 4 to 8 digits.");
  }

  if (id > 0) {
    const existing = db.prepare("SELECT * FROM teachers WHERE id=?").get(id);
    if (!existing) fail("Teacher not found.", 404);
    db.prepare(
      "UPDATE teachers SET slot_number=?, name=?, role=?, is_top_teacher=?, telegram_chat_id=?, is_active=?, pin_hash=? WHERE id=?",
    ).run(
      slot,
      name,
      role,
      isTop,
      chatId,
      isActive,
      pin ? hashPassword(pin) : existing.pin_hash,
      id,
    );
    return res.json({ ok: true, id });
  }

  if (isTop && slot >= 1 && slot <= 3) {
    const bySlot = db
      .prepare("SELECT * FROM teachers WHERE is_top_teacher=1 AND slot_number=?")
      .get(slot);
    if (bySlot) {
      db.prepare(
        "UPDATE teachers SET name=?, role=?, telegram_chat_id=?, is_active=?, pin_hash=? WHERE id=?",
      ).run(
        name,
        role,
        chatId,
        isActive,
        pin ? hashPassword(pin) : bySlot.pin_hash,
        bySlot.id,
      );
      return res.json({ ok: true, id: bySlot.id });
    }
  }

  const ins = db
    .prepare(
      "INSERT INTO teachers(slot_number, name, role, is_top_teacher, telegram_chat_id, pin_hash, is_active, created_at) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(
      slot,
      name,
      role,
      isTop,
      chatId,
      pin ? hashPassword(pin) : "",
      isActive,
      new Date().toISOString(),
    );
  res.json({ ok: true, id: Number(ins.lastInsertRowid) });
});
app.delete("/api/admin/teachers/:id", (req, res) => {
  const changes = db
    .prepare("DELETE FROM teachers WHERE id=?")
    .run(Number(req.params.id) || 0).changes;
  if (!changes) fail("Teacher not found.", 404);
  res.json({ ok: true });
});
app.post("/api/admin/telegram/settings", (req, res) => {
  const b = req.body || {};
  const old = settings();
  const botToken =
    b.telegram_bot_token !== undefined
      ? text(b.telegram_bot_token || "", "Telegram bot token", 200, false)
      : old.telegram_bot_token;
  const storageChatId =
    b.telegram_storage_chat_id !== undefined
      ? text(b.telegram_storage_chat_id || "", "Telegram archive chat ID", 64, false)
      : old.telegram_storage_chat_id;
  const joinCode =
    b.staff_join_code !== undefined
      ? text(b.staff_join_code || "", "staff join code", 40, true)
      : old.staff_join_code;
  const printMode =
    b.auto_print_mode === "os_spooler" ? "os_spooler" : "browser_kiosk";
  const printerName =
    b.printer_name !== undefined
      ? text(b.printer_name || "", "printer name", 120, false)
      : old.printer_name;
  const staffPrintConfirm =
    b.staff_print_confirm !== undefined
      ? Number(b.staff_print_confirm) === 1 || b.staff_print_confirm === true
        ? 1
        : 0
      : Number(old.staff_print_confirm || 0);
  const notifyQrScans =
    b.notify_qr_scans !== undefined
      ? Number(b.notify_qr_scans) === 0 || b.notify_qr_scans === false
        ? 0
        : 1
      : Number(old.notify_qr_scans ?? 1);
  const smtpHost =
    b.smtp_host !== undefined
      ? text(b.smtp_host || "", "SMTP host", 120, false)
      : old.smtp_host || "";
  const smtpPort =
    b.smtp_port !== undefined && String(b.smtp_port).trim() !== ""
      ? Math.min(65535, Math.max(1, Number(b.smtp_port) || 587))
      : Number(old.smtp_port || 587);
  const smtpUser =
    b.smtp_user !== undefined
      ? text(b.smtp_user || "", "SMTP username", 160, false)
      : old.smtp_user || "";
  const smtpPass =
    b.smtp_pass !== undefined
      ? text(b.smtp_pass || "", "SMTP app password", 200, false)
      : old.smtp_pass || "";
  const smtpFrom =
    b.smtp_from !== undefined
      ? text(b.smtp_from || "", "SMTP from email", 160, false)
      : old.smtp_from || "";

  const topicPending =
    b.telegram_topic_pending !== undefined
      ? text(b.telegram_topic_pending || "", "pending topic ID", 32, false)
      : old.telegram_topic_pending || "";
  const topicApproved =
    b.telegram_topic_approved !== undefined
      ? text(b.telegram_topic_approved || "", "approved topic ID", 32, false)
      : old.telegram_topic_approved || "";
  const topicScans =
    b.telegram_topic_scans !== undefined
      ? text(b.telegram_topic_scans || "", "scans topic ID", 32, false)
      : old.telegram_topic_scans || "";

  let publicUrl = old.public_url || "";
  if (b.public_url !== undefined) {
    const rawPub = text(b.public_url || "", "public domain URL", 300, false);
    if (rawPub && !normalizePortalUrl(rawPub)) {
      fail("Public domain URL must be a valid http(s) URL, e.g. https://verify.rjcschool.org");
    }
    publicUrl = rawPub ? normalizePortalUrl(rawPub) : "";
  }
  const whatsappToken =
    b.whatsapp_token !== undefined
      ? text(b.whatsapp_token || "", "WhatsApp token", 350, false)
      : old.whatsapp_token || "";
  const whatsappPhoneId =
    b.whatsapp_phone_id !== undefined
      ? text(b.whatsapp_phone_id || "", "WhatsApp Phone ID", 80, false)
      : old.whatsapp_phone_id || "";
  const whatsappReadyTemplate =
    b.whatsapp_ready_template !== undefined
      ? text(b.whatsapp_ready_template || "", "WhatsApp template name", 120, false)
      : old.whatsapp_ready_template || "";

  db.prepare(
    `UPDATE school_settings SET
      telegram_bot_token=?, telegram_storage_chat_id=?, staff_join_code=?,
      telegram_topic_pending=?, telegram_topic_approved=?, telegram_topic_scans=?,
      auto_print_mode=?, printer_name=?, staff_print_confirm=?, notify_qr_scans=?,
      smtp_host=?, smtp_port=?, smtp_user=?, smtp_pass=?, smtp_from=?,
      public_url=?, whatsapp_token=?, whatsapp_phone_id=?, whatsapp_ready_template=?
     WHERE id=1`,
  ).run(
    botToken,
    storageChatId,
    joinCode,
    topicPending,
    topicApproved,
    topicScans,
    printMode,
    printerName,
    staffPrintConfirm,
    notifyQrScans,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    smtpFrom,
    publicUrl,
    whatsappToken,
    whatsappPhoneId,
    whatsappReadyTemplate,
  );
  qrCache = null;
  repairStoredCertificateUrls();
  if (botToken) telegramBot.syncBotCommands().catch(() => {});
  res.json({ ok: true, activePortalUrl: portalUrl() });
});
app.post("/api/admin/telegram/test", async (req, res) => {
  res.json(await telegramBot.testConnection());
});
app.post("/api/admin/email/test", async (req, res) => {
  res.json(await notifyService.testSmtpConnection());
});
app.post("/api/admin/print-queue/:id/release", async (req, res) => {
  const row = await printQueue.releaseStaffPrint(
    String(req.params.id || ""),
    "School Office Admin",
  );
  if (!row) fail("Approved request not found.", 404);
  telegramBot.syncReviewedMessages(row).catch(() => {});
  res.json({ ok: true, request: row });
});
app.post("/api/admin/print-queue/:id/reprint", async (req, res) => {
  const row = await printQueue.requeuePrint(
    String(req.params.id || ""),
    "School Office Admin",
  );
  if (!row) fail("Approved request not found.", 404);
  res.json({ ok: true, request: row });
});
app.post("/api/admin/print-queue/:id/printed", (req, res) => {
  printQueue.acknowledgeBrowserPrint(
    String(req.params.id || ""),
    true,
    "",
    "School Office Admin",
  );
  res.json({ ok: true });
});
app.get("/api/admin/logs/:serial/attachment", (req, res) => {
  const row = db
    .prepare(
      "SELECT supporting_doc_name,supporting_doc_mime,supporting_doc_data FROM issued_logs WHERE serial_no=?",
    )
    .get(String(req.params.serial || ""));
  if (!row?.supporting_doc_data) fail("No supporting document attached.", 404);
  const match = /^data:([^;]+);base64,(.+)$/.exec(row.supporting_doc_data);
  if (!match) fail("Attachment unavailable.", 404);
  const bytes = Buffer.from(match[2], "base64");
  const safeName =
    String(row.supporting_doc_name || "attachment")
      .replace(/["\\\r\n]/g, "_")
      .trim() || "attachment";
  res
    .set("Content-Disposition", `attachment; filename="${safeName}"`)
    .type(row.supporting_doc_mime || match[1])
    .send(bytes);
});
const csvCell = (value) => {
  const s = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return `"${safe.replace(/"/g, '""')}"`;
};
app.get("/api/admin/logs.csv", (req, res) => {
  const q = String(req.query.q || "").trim().toLocaleLowerCase();
  const yearParam = String(req.query.year || "").trim();
  const yearNum = /^\d{4}$/.test(yearParam) ? Number(yearParam) : 0;
  const rows = db
    .prepare(
      "SELECT serial_no,gr_number,student_name,doc_title,verified_phone,is_guardian,issued_at,COALESCE(issued_year, CAST(substr(issued_at,1,4) AS INTEGER)) AS issued_year,reason,campus_code_used,supporting_doc_name,approved_by_name,approved_by_role,COALESCE(print_count,0) AS print_count,printer_name,COALESCE(scan_count,0) AS scan_count,last_scanned_at FROM issued_logs ORDER BY issued_at DESC",
    )
    .all()
    .filter((r) => (!yearNum || Number(r.issued_year) === yearNum))
    .filter((r) =>
      !q ||
      [r.serial_no, r.gr_number, r.student_name, r.doc_title, r.verified_phone, r.issued_at, r.reason, r.campus_code_used, r.supporting_doc_name, r.approved_by_name, r.approved_by_role, r.printer_name].some(
        (v) => String(v ?? "").toLocaleLowerCase().includes(q),
      ),
    );
  const header = "serial_no,gr_number,student_name,doc_title,issued_year,reason,campus_code_used,supporting_doc_name,verified_phone,is_guardian,collector_role,approved_by_name,approved_by_role,print_count,printer_name,scan_count,last_scanned_at,issued_at";
  const lines = rows.map((r) =>
    [
      r.serial_no,
      r.gr_number,
      r.student_name,
      r.doc_title,
      r.issued_year || "",
      r.reason || "",
      r.campus_code_used || "",
      r.supporting_doc_name || "",
      r.verified_phone,
      r.is_guardian ? "Yes" : "No",
      r.is_guardian ? "Authorized Guardian" : "Parent / Family Collector",
      r.approved_by_name || "",
      r.approved_by_role || "",
      r.print_count || 0,
      r.printer_name || "",
      r.scan_count || 0,
      r.last_scanned_at || "",
      r.issued_at,
    ]
      .map(csvCell)
      .join(","),
  );
  res
    .set("Content-Disposition", `attachment; filename="issued-logs${yearNum ? "-" + yearNum : ""}.csv"`)
    .type("text/csv; charset=utf-8")
    .send("\uFEFF" + [header, ...lines].join("\r\n") + "\r\n");
});
app.get("/api/admin/logs/export", async (req, res) => {
  const format = String(req.query.format || "xlsx").toLowerCase();
  if (!["xlsx", "csv", "json"].includes(format)) {
    fail("Supported export formats are xlsx, csv, and json.");
  }
  const q = String(req.query.q || "").trim().toLocaleLowerCase();
  const yearParam = String(req.query.year || "").trim();
  const monthParam = String(req.query.month || "").trim();
  const docParam = String(req.query.doc || "").trim();
  const approverParam = String(req.query.approver || "").trim();
  const copyParam = String(req.query.copy || "").trim();
  const yearNum = /^\d{4}$/.test(yearParam) ? Number(yearParam) : 0;
  const rows = db
    .prepare(
      `SELECT serial_no,gr_number,student_name,doc_title,verified_phone,is_guardian,issued_at,
        COALESCE(issued_year, CAST(substr(issued_at,1,4) AS INTEGER)) AS issued_year,
        reason,campus_code_used,supporting_doc_name,approved_by_name,approved_by_role,
        COALESCE(security_code,'') AS security_code,
        COALESCE(last_print_code,'') AS last_print_code,
        COALESCE(print_count,0) AS print_count,printer_name,
        COALESCE(scan_count,0) AS scan_count,last_scanned_at
       FROM issued_logs ORDER BY issued_at DESC`,
    )
    .all()
    .filter((r) => !yearNum || Number(r.issued_year) === yearNum)
    .filter((r) => {
      if (!monthParam || monthParam === "all") return true;
      return String(r.issued_at || "").slice(5, 7) === monthParam;
    })
    .filter((r) => !docParam || String(r.doc_title || "") === docParam)
    .filter(
      (r) =>
        !approverParam ||
        String(r.approved_by_name || "School Office") === approverParam,
    )
    .filter((r) => {
      const pCount = Number(r.print_count || 0);
      if (copyParam === "original") return pCount === 1;
      if (copyParam === "duplicate") return pCount >= 2;
      if (copyParam === "unprinted") return pCount === 0;
      if (copyParam === "scanned") return Number(r.scan_count || 0) > 0;
      return true;
    })
    .filter(
      (r) =>
        !q ||
        Object.values(r).some((v) =>
          String(v ?? "").toLocaleLowerCase().includes(q),
        ),
    );
  const serials = new Set(rows.map((r) => r.serial_no));
  const printLogs = db
    .prepare(
      "SELECT serial_no, copy_number, copy_label, COALESCE(page_no,'Page 1 of 1') AS page_no, COALESCE(print_security_code,'') AS print_security_code, printer_name, printed_by_name, printed_at FROM print_logs ORDER BY printed_at DESC, copy_number DESC",
    )
    .all()
    .filter((p) => serials.has(p.serial_no));
  const out = await buildLogsExport({ logs: rows, printLogs, format });
  res
    .set(
      "Content-Disposition",
      `attachment; filename="issued-logs${yearNum ? "-" + yearNum : ""}.${out.ext}"`,
    )
    .type(out.contentType)
    .send(out.body);
});
app.get("/api/admin/export-all", async (req, res) => {
  const format = String(req.query.format || "xlsx").toLowerCase();
  if (!["xlsx", "json"].includes(format)) {
    fail("Supported full-portal export formats are xlsx and json.");
  }
  const students = db.prepare("SELECT * FROM students ORDER BY full_name").all();
  const logs = db
    .prepare(
      `SELECT serial_no,gr_number,student_name,doc_title,verified_phone,is_guardian,issued_at,
        COALESCE(issued_year, CAST(substr(issued_at,1,4) AS INTEGER)) AS issued_year,
        reason,campus_code_used,supporting_doc_name,approved_by_name,approved_by_role,
        COALESCE(security_code,'') AS security_code,
        COALESCE(last_print_code,'') AS last_print_code,
        COALESCE(print_count,0) AS print_count,printer_name,
        COALESCE(scan_count,0) AS scan_count,last_scanned_at
       FROM issued_logs ORDER BY issued_at DESC`,
    )
    .all();
  const printLogs = db
    .prepare(
      "SELECT serial_no, copy_number, copy_label, COALESCE(page_no,'Page 1 of 1') AS page_no, COALESCE(print_security_code,'') AS print_security_code, printer_name, printed_by_name, printed_at FROM print_logs ORDER BY printed_at DESC, copy_number DESC",
    )
    .all();
  const templates = db
    .prepare(
      "SELECT id, title_en, title_mr, title_hi, sig_pos, stamp_pos, require_top_teacher, is_active FROM document_templates ORDER BY id",
    )
    .all();
  const teachers = db
    .prepare(
      "SELECT id, name, role, is_top_teacher, slot_number, is_active, created_at FROM teachers ORDER BY id",
    )
    .all();
  const out = await buildAllDataExport({
    students,
    logs,
    printLogs,
    templates,
    teachers,
    format,
  });
  const stamp = new Date().toISOString().slice(0, 10);
  res
    .set(
      "Content-Disposition",
      `attachment; filename="rjc-portal-data-${stamp}.${out.ext}"`,
    )
    .type(out.contentType)
    .send(out.body);
});
app.get("/api/admin/archive.zip", async (req, res) => {
  const yearParam = String(req.query.year || "").trim();
  if (yearParam && yearParam !== "all" && !/^\d{4}$/.test(yearParam)) {
    fail("Year must be 4 digits (e.g. 2026) or all.");
  }
  const yearNum = /^\d{4}$/.test(yearParam) ? Number(yearParam) : 0;
  const logs = db
    .prepare(
      `SELECT serial_no, gr_number, student_name, doc_title, verified_phone, is_guardian,
        issued_at, COALESCE(issued_year, CAST(substr(issued_at,1,4) AS INTEGER)) AS issued_year,
        reason, supporting_doc_name, supporting_doc_mime, supporting_doc_data,
        approved_by_name, approved_by_role, parent_photo_data, certificate_json,
        COALESCE(scan_count,0) AS scan_count, last_scanned_at
       FROM issued_logs
       ${yearNum ? "WHERE COALESCE(issued_year, CAST(substr(issued_at,1,4) AS INTEGER)) = ?" : ""}
       ORDER BY issued_at DESC`,
    )
    .all(...(yearNum ? [yearNum] : []));
  const requests = db
    .prepare(
      `SELECT id, gr_number, student_name, doc_title, status, reviewed_by_name, reviewed_by_role,
        review_channel, rejection_reason, serial_no, print_status, notification_status,
        created_at, reviewed_at, printed_at
       FROM approval_requests
       ${yearNum ? "WHERE substr(created_at, 1, 4) = ?" : ""}
       ORDER BY created_at DESC`,
    )
    .all(...(yearNum ? [String(yearNum)] : []));

  const entries = [];
  const logHeader = "serial_no,gr_number,student_name,doc_title,issued_year,verified_phone,is_guardian,approved_by_name,approved_by_role,scan_count,last_scanned_at,supporting_doc_name,issued_at";
  const logLines = logs.map((r) =>
    [
      r.serial_no,
      r.gr_number,
      r.student_name,
      r.doc_title,
      r.issued_year || "",
      r.verified_phone,
      r.is_guardian ? "Yes" : "No",
      r.approved_by_name || "",
      r.approved_by_role || "",
      r.scan_count || 0,
      r.last_scanned_at || "",
      r.supporting_doc_name || "",
      r.issued_at,
    ]
      .map(csvCell)
      .join(","),
  );
  entries.push({
    name: "issued-logs.csv",
    data: "\uFEFF" + [logHeader, ...logLines].join("\r\n") + "\r\n",
  });

  const reqHeader = "request_id,gr_number,student_name,doc_title,status,reviewed_by_name,reviewed_by_role,review_channel,rejection_reason,serial_no,print_status,notification_status,created_at,reviewed_at";
  const reqLines = requests.map((r) =>
    [
      r.id,
      r.gr_number,
      r.student_name,
      r.doc_title,
      r.status,
      r.reviewed_by_name || "",
      r.reviewed_by_role || "",
      r.review_channel || "",
      r.rejection_reason || "",
      r.serial_no || "",
      r.print_status || "",
      r.notification_status || "",
      r.created_at,
      r.reviewed_at || "",
    ]
      .map(csvCell)
      .join(","),
  );
  entries.push({
    name: "requests.csv",
    data: "\uFEFF" + [reqHeader, ...reqLines].join("\r\n") + "\r\n",
  });

  for (const r of logs.slice(0, 200)) {
    const safeSerial = String(r.serial_no || "doc").replace(/[^A-Za-z0-9_-]/g, "_");
    if (r.certificate_json) {
      try {
        const c = await decorate(JSON.parse(r.certificate_json));
        const pdfBytes = await pdf(c.certificateHtml);
        if (pdfBytes && pdfBytes.length) {
          entries.push({
            name: `certificates/${safeSerial}.pdf`,
            data: pdfBytes,
            date: r.issued_at,
          });
        }
      } catch {}
    }
    const photoMatch = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(
      String(r.parent_photo_data || ""),
    );
    if (photoMatch) {
      entries.push({
        name: `face-proofs/${safeSerial}.${photoMatch[1] === "jpeg" ? "jpg" : photoMatch[1]}`,
        data: Buffer.from(photoMatch[2], "base64"),
        date: r.issued_at,
      });
    }
    const docMatch = /^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/.exec(
      String(r.supporting_doc_data || ""),
    );
    if (docMatch) {
      const cleanDocName =
        String(r.supporting_doc_name || "application").replace(/[^A-Za-z0-9._-]/g, "_") ||
        "application";
      entries.push({
        name: `applications/${safeSerial}-${cleanDocName}`,
        data: Buffer.from(docMatch[2], "base64"),
        date: r.issued_at,
      });
    }
  }

  const zipBuf = buildZipBuffer(entries);
  const label = yearNum ? String(yearNum) : "all-years";
  res
    .set("Content-Disposition", `attachment; filename="rjc-archive-${label}.zip"`)
    .type("application/zip")
    .send(zipBuf);
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
  s.class_name = normalizeClassName(s.class_name);
  s.division = normalizeDivision(s.division);
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
  s.parent_email = text(b.parent_email || "", "parent email", 160, false);
  if (s.parent_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.parent_email))
    fail("Parent email must be a valid email address.");
  s.aadhaar_last4 = text(b.aadhaar_last4 || "", "Aadhaar last four", 4, false);
  if (s.aadhaar_last4 && !/^\d{4}$/.test(s.aadhaar_last4))
    fail("Store only the last four Aadhaar digits.");
  if (!/^\d{10}$/.test(s.parent_phone))
    fail("Parent mobile must contain 10 digits.");
  const dobParsed = normalizeDobValue(s.dob);
  if (!dobParsed) fail("Invalid date of birth. Use DD/MM/YYYY or YYYY-MM-DD.");
  s.dob = dobParsed.dob;
  s.birth_year = dobParsed.birth_year;
  s.status = b.status === "INACTIVE" ? "INACTIVE" : "ACTIVE";
  return s;
}
const upsert = db.prepare(
  "INSERT INTO students(gr_number,full_name,father_name,mother_name,class_name,division,dob,birth_year,parent_phone,parent_email,aadhaar_last4,roll_no,academic_year,blood_group,house,apaar_id,emergency_phone,bus_route,address,remarks,photo_data,status) VALUES(@gr_number,@full_name,@father_name,@mother_name,@class_name,@division,@dob,@birth_year,@parent_phone,@parent_email,@aadhaar_last4,@roll_no,@academic_year,@blood_group,@house,@apaar_id,@emergency_phone,@bus_route,@address,@remarks,@photo_data,@status) ON CONFLICT(gr_number) DO UPDATE SET full_name=excluded.full_name,father_name=excluded.father_name,mother_name=excluded.mother_name,class_name=excluded.class_name,division=excluded.division,dob=excluded.dob,birth_year=excluded.birth_year,parent_phone=excluded.parent_phone,parent_email=CASE WHEN excluded.parent_email='' AND @preserve_email=1 THEN students.parent_email ELSE excluded.parent_email END,aadhaar_last4=excluded.aadhaar_last4,roll_no=excluded.roll_no,academic_year=excluded.academic_year,blood_group=excluded.blood_group,house=excluded.house,apaar_id=excluded.apaar_id,emergency_phone=excluded.emergency_phone,bus_route=excluded.bus_route,address=excluded.address,remarks=excluded.remarks,photo_data=CASE WHEN excluded.photo_data='' AND @preserve_photo=1 THEN students.photo_data ELSE excluded.photo_data END,status=excluded.status",
);
app.post("/api/admin/students", (req, res) => {
  const preserve_photo = req.body.photo_data === undefined ? 1 : 0;
  const preserve_email = req.body.parent_email === undefined ? 1 : 0;
  upsert.run({ ...validateStudent(req.body), preserve_photo, preserve_email });
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
app.get("/api/admin/students/export", async (req, res) => {
  const format = String(req.query.format || "xlsx").toLowerCase();
  if (!["xlsx", "csv", "json"].includes(format)) {
    fail("Supported student export formats are xlsx, csv, and json.");
  }
  const q = String(req.query.q || "").trim().toLocaleLowerCase();
  const rows = db
    .prepare("SELECT * FROM students ORDER BY full_name")
    .all()
    .filter(
      (s) =>
        !q ||
        [s.gr_number, s.full_name, s.class_name, s.division, s.parent_phone].some(
          (v) => String(v ?? "").toLocaleLowerCase().includes(q),
        ),
    );
  const out = await buildStudentsExport({ students: rows, format });
  res
    .set(
      "Content-Disposition",
      `attachment; filename="rjc-students.${out.ext}"`,
    )
    .type(out.contentType)
    .send(out.body);
});
app.post("/api/admin/students/bulk", async (req, res) => {
  let rows;
  if (
    typeof req.body.dataBase64 === "string" ||
    typeof req.body.text === "string" ||
    typeof req.body.csv === "string"
  ) {
    try {
      rows = await parseStudentImport({
        filename: req.body.filename || "",
        dataBase64: req.body.dataBase64 || "",
        text: req.body.csv ?? req.body.text ?? "",
        format: req.body.format || "",
      });
    } catch (e) {
      fail(e.message || "Unable to parse import file.");
    }
  } else {
    rows = req.body.rows;
  }
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 5000)
    fail("Import between 1 and 5000 students.");
  const validated = rows.map((r, i) => {
    try {
      return validateStudent(r);
    } catch (e) {
      fail(`Row ${i + 2}: ${e.message}`);
    }
  });
  db.transaction(() => {
    for (const r of validated)
      upsert.run({
        ...r,
        preserve_photo: r.photo_data ? 0 : 1,
        preserve_email: r.parent_email ? 0 : 1,
      });
  })();
  res.json({ ok: true, count: rows.length });
});
app.get("/api/admin/sample.csv", (req, res) =>
  res
    .set("Content-Disposition", 'attachment; filename="sample-students.csv"')
    .type("text/csv")
    .send(
      "gr_number,full_name,father_name,class_name,division,dob,aadhaar_last4,parent_phone,parent_email\r\n9901,Sample Student Patil,Sample Parent Patil,8th,A,14/06/2013,1234,9800000001,parent@example.com\r\n",
    ),
);
app.get("/api/admin/sample.xlsx", async (req, res) => {
  const buf = await buildSampleStudentsXlsx();
  res
    .set("Content-Disposition", 'attachment; filename="sample-students.xlsx"')
    .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    .send(buf);
});
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
  out.require_top_teacher =
    b.require_top_teacher === 1 || b.require_top_teacher === true || b.require_top_teacher === "1"
      ? 1
      : 0;
  return out;
}
app.post("/api/admin/templates", (req, res) => {
  const t = template(req.body);
  const result = db
    .prepare(
      "INSERT INTO document_templates(title_mr,title_hi,title_en,body_html,body_mr,body_hi,sig_pos,stamp_pos,is_active,require_top_teacher) VALUES(@title_mr,@title_hi,@title_en,@body_html,@body_mr,@body_hi,@sig_pos,@stamp_pos,@is_active,@require_top_teacher)",
    )
    .run(t);
  res.json({ ok: true, id: Number(result.lastInsertRowid) });
});
app.put("/api/admin/templates/:id", (req, res) => {
  const t = template(req.body);
  if (
    !db
      .prepare(
        "UPDATE document_templates SET title_mr=@title_mr,title_hi=@title_hi,title_en=@title_en,body_html=@body_html,body_mr=@body_mr,body_hi=@body_hi,sig_pos=@sig_pos,stamp_pos=@stamp_pos,is_active=@is_active,require_top_teacher=@require_top_teacher WHERE id=@id",
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
app.get("/api/admin/backup/health", (req, res) => {
  if (!canAccessLocalCounter(req)) {
    fail("Database health view is available only on the school counter PC.", 403);
  }
  const health = checkDbHealth(db, path.join(dataDir, "school.db"));
  const dir = path.join(dataDir, "backups");
  let recentBackups = [];
  try {
    if (fs.existsSync(dir)) {
      recentBackups = fs
        .readdirSync(dir)
        .filter((f) => /\.(db|rjcbackup)$/i.test(f))
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { name: f, sizeBytes: st.size, mtime: st.mtime.toISOString() };
        })
        .sort((a, b) => b.mtime.localeCompare(a.mtime))
        .slice(0, 10);
    }
  } catch {}
  const extDir = String(process.env.BACKUP_DIR || "").trim();
  const extPassSet =
    String(process.env.BACKUP_PASSPHRASE || "").trim().length >=
    MIN_PASSPHRASE_LENGTH;
  res.json({
    ...health,
    recentBackups,
    externalBackupConfigured: Boolean(extDir),
    externalBackupEncrypted: Boolean(extDir && extPassSet),
  });
});
app.post("/api/admin/backup", async (req, res) => {
  if (!canAccessLocalCounter(req)) {
    fail("Local backup is available only on the school counter PC.", 403);
  }
  const dir = path.join(dataDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const filename =
    "school-" + new Date().toISOString().replace(/[:.]/g, "-") + ".db";
  const dest = path.join(dir, filename);
  await db.backup(dest);
  const verified = verifySqliteSnapshot(Database, dest);
  let externalMirrored = false;
  try {
    const ext = await mirrorBackupExternal(dest, new Date());
    externalMirrored = ext.mirrored;
  } catch {}
  res.json({
    ok: true,
    filename,
    counts: verified.counts,
    externalMirrored,
  });
});
app.post("/api/admin/backup/download", async (req, res) => {
  if (!canAccessLocalCounter(req)) {
    fail("Backup download is available only on the school counter PC.", 403);
  }
  const rawPass = String(req.body?.passphrase ?? "");
  if (rawPass && rawPass.length < MIN_PASSPHRASE_LENGTH) {
    fail(
      `Backup passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`,
      400,
    );
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-bak-"));
  const snapFile = path.join(tmpDir, "snapshot.db");
  try {
    await db.backup(snapFile);
    verifySqliteSnapshot(Database, snapFile);
    const snapBytes = fs.readFileSync(snapFile);
    const dateStamp = new Date().toISOString().slice(0, 10);
    if (rawPass) {
      const encBytes = encryptBackupBuffer(snapBytes, rawPass);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("X-Backup-Encrypted", "1");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="rjc-school-backup-${dateStamp}.rjcbackup"`,
      );
      return res.send(encBytes);
    }
    res.setHeader("Content-Type", "application/x-sqlite3");
    res.setHeader("X-Backup-Encrypted", "0");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="rjc-school-backup-${dateStamp}.db"`,
    );
    return res.send(snapBytes);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
const { createWhatsApp } = require("./whatsapp");
const wa = createWhatsApp({ db, issue: () => fail("Use the verified parent portal.", 403), decorate, pdf, settings, fail });
app.get("/webhook", wa.verify);
// The former conversational issuance flow predates parent sessions. It is
// disabled; outbound authentication templates use the OTP transport above.
app.post("/webhook", (req, res) => res.sendStatus(410));
app.get(
  ["/", "/admin", "/kiosk", "/parent-screen", "/staff-host"],
  (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")),
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
    telegramBot.stop();
    wa.close();
    server.close(() => {
      try {
        db.pragma("wal_checkpoint(TRUNCATE)");
      } catch {}
      db.close();
      process.exit(0);
    });
  });
