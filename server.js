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
const { esc, clean, renderCertificate, pdf, normalizeUdise } = require("./certificate");
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
const portalUrl = `http://${lanIp}:${port}`;
const local = (req) =>
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
const tokens = new Map();
const app = express();
app.disable("x-powered-by");
const allowedHosts = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  lanIp,
  ...interfaces.map((i) => i.address),
]);
if (process.env.PUBLIC_WEBHOOK_URL) {
  try {
    allowedHosts.add(new URL(process.env.PUBLIC_WEBHOOK_URL).hostname);
  } catch {
    throw Error("Invalid PUBLIC_WEBHOOK_URL");
  }
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
  if (!allowedHosts.has(req.hostname))
    return res.status(403).json({ error: "Invalid host" });
  if (
    req.headers.origin &&
    req.headers.origin !== `http://${req.headers.host}` &&
    req.headers.origin !== `https://${req.headers.host}`
  )
    return res.status(403).json({ error: "Cross-origin requests are denied" });
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-src 'self' about:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
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
    journalMode: db.pragma("journal_mode", { simple: true }),
    synchronous: db.pragma("synchronous", { simple: true }),
  }),
);
app.get("/api/campus-code", async (req, res) => {
  if (!local(req))
    return res
      .status(403)
      .json({ error: "Campus code is shown on the school monitor only." });
  if (Date.now() >= campus.expiresAt) rotate();
  if (!qrCache) {
    const snapshot = { ...campus };
    const s = settings();
    const url = `${portalUrl}/?code=${snapshot.code}`;
    const wifi = s.wifi_ssid
      ? `WIFI:T:WPA;S:${wifiEscape(s.wifi_ssid)};P:${wifiEscape(s.wifi_password)};;`
      : null;
    const data = {
      ...snapshot,
      lanIp,
      portalUrl,
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
app.get("/api/public-config", (req, res) =>
  res.json({
    templates: db
      .prepare(
        "SELECT id,title_mr,title_hi,title_en FROM document_templates WHERE is_active=1",
      )
      .all(),
    classes: db
      .prepare(
        "SELECT DISTINCT class_name,division FROM students WHERE status='ACTIVE' ORDER BY class_name,division",
      )
      .all(),
    schoolName: settings().school_name,
    isLocalKiosk:
      local(req) && ["localhost", "127.0.0.1", "[::1]"].includes(req.hostname),
    portalUrl,
  }),
);
app.post("/api/search-student", (req, res) => {
  let rows = [];
  const b = req.body;
  if (b.mode === "phone") {
    const phone = String(b.phone || "")
      .replace(/\D/g, "")
      .slice(-10);
    if (phone.length === 10)
      rows = db
        .prepare(
          "SELECT * FROM students WHERE status='ACTIVE' AND parent_phone=? LIMIT 15",
        )
        .all(phone);
  } else if (b.mode === "name") {
    const query = text(b.query || "", "name", 100, false);
    if (query.length >= 2) {
      const q = "%" + query.replace(/[!%_]/g, "!$&") + "%";
      rows = db
        .prepare(
          "SELECT * FROM students WHERE status='ACTIVE' AND (?='' OR class_name=?) AND (?='' OR division=?) AND (full_name LIKE ? ESCAPE '!' OR father_name LIKE ? ESCAPE '!') LIMIT 15",
        )
        .all(
          b.className || "",
          b.className || "",
          b.division || "",
          b.division || "",
          q,
          q,
        );
    }
  }
  res.json({
    students: rows.map((s) => ({
      gr_number: s.gr_number,
      full_name: s.full_name,
      class_name: s.class_name,
      division: s.division,
      masked_phone: "******" + s.parent_phone.slice(-4),
    })),
  });
});
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
  if (b.isGuardian === true) {
    valid =
      String(b.birthYear || "") === student.birth_year &&
      String(b.confirmGr || "") === student.gr_number &&
      /^\d{10}$/.test(String(b.guardianPhone || ""));
  } else if (b.verificationMode === "backup") {
    valid =
      String(b.confirmGr || "") === student.gr_number &&
      /^\d{4}$/.test(String(b.aadhaarLast4 || "")) &&
      student.aadhaar_last4 &&
      String(b.aadhaarLast4) === student.aadhaar_last4;
  } else valid = String(b.birthYear || "") === student.birth_year;
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
function issue(b, allowLocal = false, receiptId = null) {
  for (const key of ["isGuardian", "isLocalKiosk"])
    if (b[key] !== undefined && typeof b[key] !== "boolean")
      fail("Invalid " + key);
  if (
    b.verificationMode !== undefined &&
    !["primary", "backup"].includes(b.verificationMode)
  )
    fail("Invalid verification method.");
  const isLocal = b.isLocalKiosk === true && allowLocal;
  if (
    !isLocal &&
    (Date.now() >= campus.expiresAt ||
      String(b.campusCode || "") !== campus.code)
  )
    fail("Campus code is invalid or expired. Check the school monitor.", 403);
  const student = db
    .prepare("SELECT * FROM students WHERE gr_number=? AND status='ACTIVE'")
    .get(text(b.grNumber, "GR number"));
  if (!student) fail("Student record not found.", 404);
  const tpl = db
    .prepare("SELECT * FROM document_templates WHERE id=? AND is_active=1")
    .get(Number(b.templateId) || 0);
  if (!tpl) fail("Document template is unavailable.", 404);
  checkFamily(b, student);
  const year = new Intl.DateTimeFormat("en", {
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(new Date());
  const prefix = `RGC-${year}-`;
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
    class_name: student.class_name,
    division: student.division,
    gr_number: student.gr_number,
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
    verificationUrl: `${portalUrl}/verify/${serialNo}`,
  };
  db.transaction(() => {
    db.prepare(
      "INSERT INTO issued_logs(serial_no,gr_number,student_name,doc_title,verified_phone,is_guardian,issued_at,certificate_json,download_hash) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      serialNo,
      student.gr_number,
      student.full_name,
      cert.docTitle,
      b.isGuardian ? b.guardianPhone : student.parent_phone,
      b.isGuardian ? 1 : 0,
      new Date().toISOString(),
      JSON.stringify(cert),
      crypto.createHash("sha256").update(downloadToken).digest("hex"),
    );
    if (receiptId)
      db.prepare("UPDATE webhook_receipts SET serial_no=? WHERE id=?").run(
        serialNo,
        receiptId,
      );
  })();
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
app.post("/api/generate-document", async (req, res) =>
  res.json(
    await decorate(
      issue(
        req.body,
        local(req) &&
          ["localhost", "127.0.0.1", "[::1]"].includes(req.hostname),
      ),
    ),
  ),
);
app.get("/api/documents/:serial/pdf", async (req, res) => {
  const row = db
    .prepare("SELECT * FROM issued_logs WHERE serial_no=?")
    .get(req.params.serial);
  const hash = crypto
    .createHash("sha256")
    .update(String(req.headers["x-document-token"] || ""))
    .digest("hex");
  if (
    !row?.download_hash ||
    !crypto.timingSafeEqual(
      Buffer.from(hash),
      Buffer.from(row.download_hash),
    ) ||
    Date.now() - Date.parse(row.issued_at) > 300000
  )
    fail("Document download has expired. Generate a new certificate.", 403);
  const c = await decorate(JSON.parse(row.certificate_json));
  res
    .set("Content-Disposition", `attachment; filename="${row.serial_no}.pdf"`)
    .type("pdf")
    .send(await pdf(c.certificateHtml));
});
app.get("/verify/:serial", async (req, res) => {
  const log = db
    .prepare(
      "SELECT serial_no,doc_title,issued_at FROM issued_logs WHERE serial_no=?",
    )
    .get(req.params.serial);
  res
    .status(log ? 200 : 404)
    .type("html")
    .send(
      `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RGC · Verify certificate</title><style>body{font:18px system-ui;background:#f2f2f7;padding:10vh 6vw;color:#17202b}main{background:white;border-radius:24px;max-width:600px;padding:36px;margin:auto}p{overflow-wrap:anywhere}</style><main><h1>${log ? "✓ School record found" : "Record not found"}</h1>${log ? `<p>${esc(log.doc_title)}</p><p>Reference: ${esc(log.serial_no)}</p><p>Issued: ${esc(log.issued_at)}</p><small>Verify identity and the printed details with the school office. This page confirms the reference exists; it does not authenticate altered printed content.</small>` : "<p>Check the reference number or contact the school office.</p>"}</main></html>`,
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
app.post("/api/admin/logout", (req, res) => {
  tokens.delete(req.headers["x-admin-token"]);
  res.json({ ok: true });
});
app.get("/api/admin/dashboard", (req, res) =>
  res.json({
    settings: settings(),
    students: db.prepare("SELECT * FROM students ORDER BY full_name").all(),
    templates: db.prepare("SELECT * FROM document_templates ORDER BY id").all(),
    logs: db
      .prepare(
        "SELECT serial_no,gr_number,student_name,doc_title,verified_phone,is_guardian,issued_at FROM issued_logs ORDER BY issued_at DESC",
      )
      .all(),
  }),
);
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
  "INSERT INTO students(gr_number,full_name,father_name,class_name,division,dob,birth_year,parent_phone,aadhaar_last4,status) VALUES(@gr_number,@full_name,@father_name,@class_name,@division,@dob,@birth_year,@parent_phone,@aadhaar_last4,@status) ON CONFLICT(gr_number) DO UPDATE SET full_name=excluded.full_name,father_name=excluded.father_name,class_name=excluded.class_name,division=excluded.division,dob=excluded.dob,birth_year=excluded.birth_year,parent_phone=excluded.parent_phone,aadhaar_last4=excluded.aadhaar_last4,status=excluded.status",
);
app.post("/api/admin/students", (req, res) => {
  upsert.run(validateStudent(req.body));
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
    for (const r of validated) upsert.run(r);
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
  if (req.body.udise_no !== undefined)
    s.udise_no = normalizeUdise(s.udise_no);
  for (const k of ["logo_data", "signature_data", "stamp_data"])
    if (req.body[k] !== undefined) s[k] = png(req.body[k]);
  db.prepare(
    "UPDATE school_settings SET school_name=@school_name,school_subtitle=@school_subtitle,udise_no=@udise_no,whatsapp_number=@whatsapp_number,wifi_ssid=@wifi_ssid,wifi_password=@wifi_password,logo_data=@logo_data,signature_data=@signature_data,stamp_data=@stamp_data WHERE id=1",
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
      verificationUrl: portalUrl + "/verify/PREVIEW",
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
const wa = createWhatsApp({ db, issue, decorate, pdf, settings, fail });
app.get("/webhook", wa.verify);
app.post("/webhook", wa.receive);
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
    `RGC School Document Portal\nSchool monitor: http://localhost:${port}\nLAN portal: ${portalUrl}\nAdmin: see ${path.join(dataDir, "admin-credentials.txt")}\nSample GR / birth year / Aadhaar last four: 4501/2013/1234, 4502/2011/2345, 4503/2012/3456, 4504/2014/4567, 4505/2015/5678`,
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
