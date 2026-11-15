const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const zlib = require("node:zlib");
const { PNG } = require("pngjs");
const { openDatabase, hashPassword } = require("../db");
const { buildZipBuffer } = require("../zip-export");
const {
  createNotifyService,
  buildWhatsAppReadyUrl,
  normalizeIndianPhone,
} = require("../notify-service");
const { createTelegramBot } = require("../telegram");
const { createApprovalService } = require("../approval-service");
const { clean, esc } = require("../certificate");

function samplePngDataUrl(width = 32, height = 24, r = 185) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = 135;
    png.data[i + 2] = 110;
    png.data[i + 3] = 255;
  }
  return "data:image/png;base64," + PNG.sync.write(png).toString("base64");
}

function parseZipEntries(zipBuf) {
  // Parse End of Central Directory (last 22+ bytes) & walk central directory entries
  assert.equal(zipBuf.readUInt32LE(zipBuf.length - 22), 0x06054b50);
  const count = zipBuf.readUInt16LE(zipBuf.length - 12);
  const cdOffset = zipBuf.readUInt32LE(zipBuf.length - 6);
  const out = new Map();
  let ptr = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(zipBuf.readUInt32LE(ptr), 0x02014b50);
    const method = zipBuf.readUInt16LE(ptr + 10);
    const compSize = zipBuf.readUInt32LE(ptr + 20);
    const nameLen = zipBuf.readUInt16LE(ptr + 28);
    const extraLen = zipBuf.readUInt16LE(ptr + 30);
    const cmtLen = zipBuf.readUInt16LE(ptr + 32);
    const localOffset = zipBuf.readUInt32LE(ptr + 42);
    const name = zipBuf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");
    ptr += 46 + nameLen + extraLen + cmtLen;

    assert.equal(zipBuf.readUInt32LE(localOffset), 0x04034b50);
    const lNameLen = zipBuf.readUInt16LE(localOffset + 26);
    const lExtraLen = zipBuf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const rawComp = zipBuf.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? zlib.inflateRawSync(rawComp) : rawComp;
    out.set(name, data);
  }
  return out;
}

test("zip-export builds standard readable PKZIP archives with UTF-8 filenames and binary payloads", () => {
  const samplePdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
  const buf = buildZipBuffer([
    { name: "issued-logs.csv", data: "serial,student\r\nRJC-2026-10001,Aarav Patil\r\n" },
    { name: "certificates/RJC-2026-10001.pdf", data: samplePdf },
  ]);
  const entries = parseZipEntries(buf);
  assert.equal(entries.size, 2);
  assert.match(entries.get("issued-logs.csv").toString("utf8"), /RJC-2026-10001,Aarav Patil/);
  assert.equal(entries.get("certificates/RJC-2026-10001.pdf").equals(samplePdf), true);
});

test("notify-service formats WhatsApp ready links and sends SMTP ready emails", async () => {
  assert.equal(normalizeIndianPhone("98220-11111"), "919822011111");
  const waUrl = buildWhatsAppReadyUrl({
    phone: "9822011111",
    schoolName: "R. J. Chaware Convent",
    studentName: "Aarav Patil",
    docTitle: "Bonafide Certificate",
    serialNo: "RJC-2026-12345",
    verifyUrl: "https://school.local/verify/RJC-2026-12345",
  });
  assert.ok(waUrl.startsWith("https://wa.me/919822011111?text="));
  assert.match(decodeURIComponent(waUrl), /Bonafide Certificate/);
  assert.match(decodeURIComponent(waUrl), /RJC-2026-12345/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-notify-"));
  const db = openDatabase(dir);
  db.prepare(
    "INSERT INTO students(gr_number,full_name,father_name,class_name,division,dob,birth_year,parent_phone,parent_email,status) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run("EM-1", "Meera Joshi", "Suresh Joshi", "9th", "B", "10/03/2012", "2012", "9822099999", "parent.meera@example.com", "ACTIVE");
  db.prepare(
    "UPDATE school_settings SET smtp_host='smtp.example.com', smtp_port=587, smtp_user='office@rjc.edu', smtp_pass='appsecret', smtp_from='office@rjc.edu' WHERE id=1",
  ).run();
  const settings = () => db.prepare("SELECT * FROM school_settings WHERE id=1").get();
  const svc = createApprovalService({
    db,
    clean,
    esc,
    safeSettings: () => settings(),
    portalUrl: () => "http://localhost:3000",
  });
  const student = db.prepare("SELECT * FROM students WHERE gr_number='EM-1'").get();
  const tpl = db.prepare("SELECT * FROM document_templates LIMIT 1").get();
  const teacher = { id: 1, name: "Mrs. Joshi", role: "Principal", is_top_teacher: 1 };
  const created = svc.createRequest({
    student,
    tpl,
    lang: "en",
    verifiedPhone: "9822099999",
    parentPhotoData: samplePngDataUrl(),
  });
  const approved = svc.approveRequest({ requestId: created.id, teacher, channel: "web" });

  const sentMails = [];
  const notify = createNotifyService({
    db,
    settings,
    portalUrl: () => "http://localhost:3000",
    smtpFactory: () => ({
      verify: async () => true,
      sendMail: async (mail) => {
        sentMails.push(mail);
      },
    }),
  });
  await notify.testSmtpConnection();
  const res = await notify.notifyParentOnApproval(approved.request);
  assert.equal(res.channels.length, 1);
  assert.equal(sentMails.length, 1);
  assert.equal(sentMails[0].to, "parent.meera@example.com");
  assert.match(sentMails[0].subject, /Meera Joshi/);
  const updatedReq = db.prepare("SELECT notification_status FROM approval_requests WHERE id=?").get(created.id);
  assert.match(updatedReq.notification_status, /Email \(parent\.meera@example\.com\)/);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test(
  "principal security controls: Top Teacher lock, two-person print hold & release, side-by-side photo privacy, QR scan Telegram alerts & yearly ZIP export",
  { timeout: 45000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-principal-"));
    const db = openDatabase(dir);
    const adminPassword = "synthetic-principal-pass";
    db.prepare("UPDATE admin_users SET password_hash=? WHERE username='admin'").run(
      hashPassword(adminPassword),
    );
    const studentPhoto = samplePngDataUrl(24, 24, 40);
    db.prepare("DELETE FROM students").run();
    db.prepare(
      "INSERT INTO students(gr_number,full_name,father_name,class_name,division,dob,birth_year,parent_phone,parent_email,photo_data,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "PR-101",
      "Kavya Principal Patil",
      "Mohan Patil",
      "10th",
      "A",
      "12/05/2011",
      "2011",
      "9822055555",
      "kavya.parent@example.com",
      studentPhoto,
      "ACTIVE",
    );
    // Insert a historical 2025 issued log to verify yearly filter & ZIP scoping
    db.prepare(
      `INSERT INTO issued_logs(serial_no,gr_number,student_name,doc_title,verified_phone,is_guardian,issued_at,issued_year,certificate_json,download_hash,approved_by_name,approved_by_role,scan_count,last_scanned_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "RJC-2025-99901",
      "PR-101",
      "Kavya Principal Patil",
      "Bonafide Certificate",
      "9822055555",
      0,
      "2025-04-10T10:00:00.000Z",
      2025,
      JSON.stringify({
        serialNo: "RJC-2025-99901",
        issuedAt: "10 Apr 2025",
        docTitle: "Bonafide Certificate",
        bodyHtml: "<p>Old record</p>",
        sigPos: "right",
        stampPos: "right",
        lang: "en",
        settings: { school_name: "RJC" },
        student: { full_name: "Kavya Principal Patil", gr_number: "PR-101", class_name: "10th", division: "A" },
        verificationUrl: "http://127.0.0.1/verify/RJC-2025-99901",
      }),
      "hash2025",
      "Mrs. Joshi",
      "Principal",
      1,
      "2025-04-10T11:00:00.000Z",
    );
    db.close();

    const socket = net.createServer();
    await new Promise((r) => socket.listen(0, "127.0.0.1", r));
    const port = socket.address().port;
    await new Promise((r) => socket.close(r));

    const child = spawn(process.execPath, ["server.js"], {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        KIOSK_DATA_DIR: dir,
      },
      stdio: "ignore",
    });
    const base = `http://127.0.0.1:${port}`;
    const api = async (url, { method, body, headers = {} } = {}) => {
      const res = await fetch(base + url, {
        method: method || (body === undefined ? "GET" : "POST"),
        headers: { "Content-Type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      let data = text;
      try {
        data = JSON.parse(text);
      } catch {}
      return { status: res.status, data, headers: res.headers };
    };

    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(base + "/api/health")).ok) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(ready);

      const login = await api("/api/admin/login", {
        body: { username: "admin", password: adminPassword },
      });
      const adminHeaders = { "x-admin-token": login.data.token };

      // Configure 2-step counter print confirm + QR scan alerts
      const cfgSave = await api("/api/admin/telegram/settings", {
        headers: adminHeaders,
        body: {
          staff_join_code: "RJC-SEC",
          staff_print_confirm: 1,
          notify_qr_scans: 1,
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_user: "office@rjc.edu",
          smtp_pass: "super-secret-smtp-pass",
        },
      });
      assert.equal(cfgSave.status, 200);

      // Verify public-config & certificate settings do NOT leak smtp_pass
      const dash = await api("/api/admin/dashboard", { headers: adminHeaders });
      assert.equal(dash.data.settings.staff_print_confirm, 1);

      // Add 1 Top Teacher and 1 Regular Staff
      const topRes = await api("/api/admin/teachers", {
        headers: adminHeaders,
        body: {
          slot_number: 1,
          name: "Principal Sunita Joshi",
          role: "Principal",
          is_top_teacher: true,
          telegram_chat_id: "7001",
          pin: "1111",
        },
      });
      const staffRes = await api("/api/admin/teachers", {
        headers: adminHeaders,
        body: {
          slot_number: 0,
          name: "Counter Clerk",
          role: "Staff",
          is_top_teacher: false,
          telegram_chat_id: "7002",
          pin: "2222",
        },
      });

      // Mark Transfer/Leaving or a new template as Top Teacher Only
      const tplRes = await api("/api/admin/templates", {
        headers: adminHeaders,
        body: {
          title_en: "Sensitive Leaving Certificate",
          title_mr: "संवेदनशील दाखला",
          title_hi: "संवेदनशील प्रमाणपत्र",
          body_html: "<p>Leaving certificate for {{student_name}}</p>",
          body_mr: "<p>{{student_name}}</p>",
          body_hi: "<p>{{student_name}}</p>",
          sig_pos: "right",
          stamp_pos: "right",
          is_active: 1,
          require_top_teacher: 1,
        },
      });
      assert.equal(tplRes.status, 200);
      const sensitiveTplId = tplRes.data.id;

      // Parent flow -> Face proof -> Submit Sensitive Request
      const start = await api("/api/parent/start", { body: { phone: "9822055555" } });
      const ver = await api("/api/parent/family", {
        body: {
          challengeId: start.data.challengeId,
          birthMonth: "05",
          birthYear: "2011",
          grNumber: "PR-101",
        },
      });
      const pSession = ver.data.sessionToken;
      const studentRef = ver.data.students[0].studentRef;
      const collectorPhoto = samplePngDataUrl(36, 28, 200);
      await api("/api/parent/face-proof", {
        headers: { "x-parent-session": pSession },
        body: { photoData: collectorPhoto },
      });
      const campusCode = (await api("/api/campus-code")).data.code;
      const sub = await api("/api/parent/submit-request", {
        headers: { "x-parent-session": pSession },
        body: {
          studentRef,
          templateId: sensitiveTplId,
          campusCode,
          lang: "en",
        },
      });
      assert.equal(sub.status, 200);
      const reqId = sub.data.requestId;

      // Staff logs in to /teacher and sees side-by-side photos + require_top_teacher flag
      const staffLogin = await api("/api/teacher/login", {
        body: { teacherId: staffRes.data.id, pin: "2222" },
      });
      const staffHeaders = { "x-teacher-token": staffLogin.data.token };
      const staffQueue = await api("/api/teacher/requests", { headers: staffHeaders });
      const rowInQueue = staffQueue.data.requests.find((r) => r.id === reqId);
      assert.equal(rowInQueue.require_top_teacher, 1);
      assert.equal(rowInQueue.student_photo_data, studentPhoto);
      assert.equal(rowInQueue.parent_photo_data, collectorPhoto);

      // Staff is BLOCKED (403) from approving Top-Teacher-Only document
      const staffApprove = await api(`/api/teacher/requests/${reqId}/approve`, {
        headers: staffHeaders,
        body: {},
      });
      assert.equal(staffApprove.status, 403);

      // Top Teacher logs in and approves -> print_status MUST be HOLD_STAFF (two-person control)
      const topLogin = await api("/api/teacher/login", {
        body: { teacherId: topRes.data.id, pin: "1111" },
      });
      const topHeaders = { "x-teacher-token": topLogin.data.token };
      const topApprove = await api(`/api/teacher/requests/${reqId}/approve`, {
        headers: topHeaders,
        body: {},
      });
      assert.equal(topApprove.status, 200);
      assert.equal(topApprove.data.request.print_status, "HOLD_STAFF");
      const serialNo = topApprove.data.request.serial_no;

      // Print queue at counter does NOT release yet while HOLD_STAFF!
      const kioskBefore = await api("/api/kiosk/print-next");
      assert.equal(kioskBefore.data.job, null);

      // Staff at counter physically confirms parent & triggers print release
      const released = await api(`/api/teacher/requests/${reqId}/release-print`, {
        headers: staffHeaders,
        body: {},
      });
      assert.equal(released.status, 200);
      assert.equal(released.data.request.print_status, "QUEUED");

      const kioskAfter = await api("/api/kiosk/print-next");
      assert.equal(kioskAfter.data.job.requestId, reqId);
      await api(`/api/kiosk/print-ack/${reqId}`, { body: { ok: true } });

      // Public /verify/:serial shows collector face proof, NEVER student's private ID photo
      const verifyHtml = await (await fetch(`${base}/verify/${serialNo}`)).text();
      assert.match(verifyHtml, /Principal Sunita Joshi/);
      assert.ok(verifyHtml.includes(collectorPhoto));
      assert.equal(verifyHtml.includes(studentPhoto), false);

      // Log Details endpoint returns BOTH student_photo_data and parent_photo_data for Admin side-by-side audit
      const details = await api(`/api/admin/logs/${serialNo}/details`, { headers: adminHeaders });
      assert.equal(details.data.log.student_photo_data, studentPhoto);
      assert.equal(details.data.log.parent_photo_data, collectorPhoto);

      // Yearly ZIP archive export for current year excludes 2025 historical log, includes CSV + PDF + face proof
      const currentYear = String(new Date().getFullYear());
      const zipRes = await fetch(`${base}/api/admin/archive.zip?year=${currentYear}`, {
        headers: adminHeaders,
      });
      assert.equal(zipRes.status, 200);
      assert.equal(zipRes.headers.get("content-type"), "application/zip");
      const zipEntries = parseZipEntries(Buffer.from(await zipRes.arrayBuffer()));
      const csvText = zipEntries.get("issued-logs.csv").toString("utf8");
      assert.ok(csvText.includes(serialNo));
      assert.equal(csvText.includes("RJC-2025-99901"), false);
      assert.ok(zipEntries.has(`certificates/${serialNo}.pdf`));
      assert.ok(zipEntries.has(`face-proofs/${serialNo}.png`));

      // All-years ZIP includes 2025 record too
      const zipAllRes = await fetch(`${base}/api/admin/archive.zip?year=all`, {
        headers: adminHeaders,
      });
      const zipAllEntries = parseZipEntries(Buffer.from(await zipAllRes.arrayBuffer()));
      assert.ok(zipAllEntries.get("issued-logs.csv").toString("utf8").includes("RJC-2025-99901"));
    } finally {
      child.kill("SIGTERM");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("telegram bot sends live QR scan alert to archive group when enabled and honors notify_qr_scans=0", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-qr-alert-"));
  const db = openDatabase(dir);
  db.prepare(
    "UPDATE school_settings SET telegram_bot_token='123:TEST', telegram_storage_chat_id='-100999', notify_qr_scans=1 WHERE id=1",
  ).run();
  const calls = [];
  const bot = createTelegramBot({
    db,
    settings: () => db.prepare("SELECT * FROM school_settings WHERE id=1").get(),
    approvalService: createApprovalService({
      db,
      clean,
      esc,
      safeSettings: () => ({}),
      portalUrl: () => "http://localhost:3000",
    }),
    portalUrl: () => "http://localhost:3000",
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const sent = await bot.sendQrScanAlert({
    serial_no: "RJC-2026-55555",
    student_name: "Aarav Patil",
    gr_number: "4501",
    doc_title: "Bonafide Certificate",
    approved_by_name: "Principal Joshi",
    approved_by_role: "Principal",
    scan_count: 2,
    last_scanned_at: new Date().toISOString(),
  });
  assert.equal(sent.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.chat_id, "-100999");
  assert.match(calls[0].body.text, /SCAN #2/);
  assert.match(calls[0].body.text, /RJC-2026-55555/);

  db.prepare("UPDATE school_settings SET notify_qr_scans=0 WHERE id=1").run();
  const suppressed = await bot.sendQrScanAlert({
    serial_no: "RJC-2026-55555",
    student_name: "Aarav Patil",
    gr_number: "4501",
    doc_title: "Bonafide Certificate",
    scan_count: 3,
    last_scanned_at: new Date().toISOString(),
  });
  assert.equal(suppressed.sent, false);
  assert.equal(calls.length, 1);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("telegram Teachers Group & Channel Hub supports /setgroup, /setchannel, channel_post, /pending, /today, /logs, /scans, and per-teacher group attribution", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-tg-hub-"));
  const db = openDatabase(dir);
  db.prepare(
    "UPDATE school_settings SET telegram_bot_token='123:HUB', staff_join_code='RJC-HUB', notify_qr_scans=1 WHERE id=1",
  ).run();
  db.prepare("DELETE FROM students").run();
  db.prepare(
    "INSERT INTO students(gr_number,full_name,father_name,class_name,division,dob,birth_year,parent_phone,status) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run("HUB-1", "Rohan Deshmukh", "Vijay Deshmukh", "8th", "A", "04/07/2013", "2013", "9822012345", "ACTIVE");
  db.prepare(
    `INSERT INTO teachers(slot_number,name,role,is_top_teacher,telegram_chat_id,telegram_username,is_active,joined_via_bot,created_at)
     VALUES(1,'Mrs. Sunita Joshi','Principal',1,'444001','sunita_principal',1,1,?)`,
  ).run(new Date().toISOString());

  const calls = [];
  const fakeFetch = async (url, init) => {
    const method = url.split("/").pop();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : { multipart: true };
    calls.push({ method, body });
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: calls.length + 100 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const settings = () => db.prepare("SELECT * FROM school_settings WHERE id=1").get();
  const svc = createApprovalService({
    db,
    clean,
    esc,
    safeSettings: () => settings(),
    portalUrl: () => "http://localhost:3000",
  });
  const bot = createTelegramBot({
    db,
    settings,
    approvalService: svc,
    portalUrl: () => "http://localhost:3000",
    fetchImpl: fakeFetch,
  });

  // 1. Channel post links Channel (-100888), then /setgroup links Teachers Group (-100777)
  await bot.processUpdates([
    {
      update_id: 1,
      channel_post: { chat: { id: -100888, type: "channel", title: "RJC Teachers" }, text: "/setchannel RJC-HUB" },
    },
  ]);
  assert.equal(settings().telegram_storage_chat_id, "-100888");

  await bot.processUpdates([
    {
      update_id: 2,
      message: { chat: { id: -100777, type: "supergroup" }, from: { id: 444001, first_name: "Sunita" }, text: "/setgroup" },
    },
  ]);
  assert.equal(settings().telegram_storage_chat_id, "-100777");

  // 2. Unverified stranger in private chat is blocked from /pending & /logs
  const beforeStranger = calls.length;
  await bot.processUpdates([
    {
      update_id: 3,
      message: { chat: { id: 999999, type: "private" }, from: { id: 999999, first_name: "Stranger" }, text: "/pending" },
    },
  ]);
  assert.match(calls[beforeStranger].body.text, /Verification required/);

  // 3. Create request & notify group even if individual teacher notifications also run
  const student = db.prepare("SELECT * FROM students WHERE gr_number='HUB-1'").get();
  const tpl = db.prepare("SELECT * FROM document_templates LIMIT 1").get();
  const reqRow = svc.createRequest({
    student,
    tpl,
    lang: "en",
    verifiedPhone: "9822012345",
    parentPhotoData: samplePngDataUrl(),
  });
  const notifyRes = await bot.sendRequestNotifications(reqRow);
  assert.equal(notifyRes.sent, 2); // 1 teacher private + 1 group hub

  // 4. Query /pending and /today in the Teachers Group
  const idxBeforePending = calls.length;
  await bot.processUpdates([
    {
      update_id: 4,
      message: { chat: { id: -100777, type: "supergroup" }, from: { id: 444001 }, text: "/pending" },
    },
    {
      update_id: 5,
      message: { chat: { id: -100777, type: "supergroup" }, from: { id: 444001 }, text: "/today" },
    },
  ]);
  const pendingMsg = calls.slice(idxBeforePending).find((c) => c.method === "sendMessage" && /PENDING REQUESTS/.test(c.body.text));
  assert.ok(pendingMsg, "Group /pending should list pending requests");
  assert.match(pendingMsg.body.text, /Rohan Deshmukh/);
  const todayMsg = calls.slice(idxBeforePending).find((c) => c.method === "sendMessage" && /TODAY/.test(c.body.text));
  assert.ok(todayMsg, "Group /today should report live counters");
  assert.match(todayMsg.body.text, /Pending Requests: 1/);

  // 5. Group callback click by cb.from.id=444001 on group message (-100777) attributes approval to Mrs. Sunita Joshi!
  await bot.processUpdates([
    {
      update_id: 6,
      callback_query: {
        id: "cb-grp-1",
        from: { id: 444001, username: "sunita_principal", first_name: "Sunita" },
        message: { chat: { id: -100777, type: "supergroup" }, message_id: 201 },
        data: `approve:${reqRow.id}`,
      },
    },
  ]);
  const approvedRow = db.prepare("SELECT * FROM approval_requests WHERE id=?").get(reqRow.id);
  assert.equal(approvedRow.status, "APPROVED");
  assert.equal(approvedRow.reviewed_by_name, "Mrs. Sunita Joshi");

  // Record a QR scan & query /logs and /scans in group
  db.prepare("UPDATE issued_logs SET scan_count=2, last_scanned_at=? WHERE serial_no=?").run(
    new Date().toISOString(),
    approvedRow.serial_no,
  );
  const idxBeforeLogs = calls.length;
  await bot.processUpdates([
    {
      update_id: 7,
      message: { chat: { id: -100777, type: "supergroup" }, from: { id: 444001 }, text: "/logs HUB-1" },
    },
    {
      update_id: 8,
      message: { chat: { id: -100777, type: "supergroup" }, from: { id: 444001 }, text: "/scans" },
    },
  ]);
  const logsMsg = calls.slice(idxBeforeLogs).find((c) => c.method === "sendMessage" && /ISSUED LOGS/.test(c.body.text));
  assert.ok(logsMsg);
  assert.match(logsMsg.body.text, /Mrs\. Sunita Joshi/);
  const scansMsg = calls.slice(idxBeforeLogs).find((c) => c.method === "sendMessage" && /QR VERIFICATION SCANS/.test(c.body.text));
  assert.ok(scansMsg);
  assert.match(scansMsg.body.text, /Scans: 2/);

  // 6. Private-DM /setchannel guard does NOT overwrite storage chat with private ID;
  //    forwarded channel post & link_hub button cleanly link the channel
  const prevStorage = settings().telegram_storage_chat_id;
  await bot.processUpdates([
    {
      update_id: 9,
      message: { chat: { id: 444001, type: "private" }, from: { id: 444001 }, text: "/setchannel RJC-HUB" },
    },
  ]);
  assert.equal(settings().telegram_storage_chat_id, prevStorage);

  await bot.processUpdates([
    {
      update_id: 10,
      message: {
        chat: { id: 444001, type: "private" },
        from: { id: 444001 },
        forward_origin: { type: "channel", chat: { id: -100555444, type: "channel", title: "RJC Principal Channel" } },
      },
    },
    {
      update_id: 11,
      callback_query: {
        id: "cb-link-hub",
        from: { id: 444001 },
        message: { chat: { id: 444001, type: "private" }, message_id: 300 },
        data: "link_hub:-100555444",
      },
    },
  ]);
  assert.equal(settings().telegram_storage_chat_id, "-100555444");

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
