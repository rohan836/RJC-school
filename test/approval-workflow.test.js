const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { PNG } = require("pngjs");
const Database = require("better-sqlite3");
const { parse } = require("csv-parse/sync");
const { openDatabase, hashPassword } = require("../db");
const { createApprovalService } = require("../approval-service");
const { createTelegramBot } = require("../telegram");
const { clean, esc } = require("../certificate");

function samplePngDataUrl(width = 32, height = 24) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 185;
    png.data[i + 1] = 135;
    png.data[i + 2] = 110;
    png.data[i + 3] = 255;
  }
  return "data:image/png;base64," + PNG.sync.write(png).toString("base64");
}

test(
  "full approval workflow: single-use mobile QR isolation, face proof gate, teacher + Telegram staff approval, counter print & QR scan audit",
  { timeout: 45000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-approval-"));
    const db = openDatabase(dir);
    const adminPassword = "synthetic-approval-password";
    db.prepare("UPDATE admin_users SET password_hash=? WHERE username='admin'").run(
      hashPassword(adminPassword),
    );
    db.prepare("DELETE FROM students").run();
    db.prepare(
      "INSERT INTO students(gr_number,full_name,father_name,class_name,division,dob,birth_year,parent_phone,status) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      "AP-101",
      "Aarav Test Patil",
      "Sunil Patil",
      "8th",
      "A",
      "14/06/2013",
      "2013",
      "9822011111",
      "ACTIVE",
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
        WHATSAPP_TOKEN: "",
        PHONE_NUMBER_ID: "",
        WHATSAPP_AUTH_TEMPLATE: "",
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

      // 1. Admin login & setup 3 Top Teachers + 1 Staff member + Telegram settings
      const login = await api("/api/admin/login", {
        body: { username: "admin", password: adminPassword },
      });
      assert.equal(login.status, 200);
      const adminHeaders = { "x-admin-token": login.data.token };

      const t1 = await api("/api/admin/teachers", {
        headers: adminHeaders,
        body: {
          slot_number: 1,
          name: "Mrs. Joshi",
          role: "Principal",
          is_top_teacher: true,
          telegram_chat_id: "10001",
          pin: "1111",
          is_active: true,
        },
      });
      assert.equal(t1.status, 200);
      const t2 = await api("/api/admin/teachers", {
        headers: adminHeaders,
        body: {
          slot_number: 2,
          name: "Mr. Deshmukh",
          role: "Vice Principal",
          is_top_teacher: true,
          telegram_chat_id: "10002",
          pin: "2222",
          is_active: true,
        },
      });
      assert.equal(t2.status, 200);
      const t3 = await api("/api/admin/teachers", {
        headers: adminHeaders,
        body: {
          slot_number: 3,
          name: "Mrs. Kulkarni",
          role: "Senior Teacher",
          is_top_teacher: true,
          telegram_chat_id: "10003",
          pin: "3333",
          is_active: true,
        },
      });
      assert.equal(t3.status, 200);

      // 2. Front-panel single-use QR handoff & mobile isolation
      const campus1 = await api("/api/campus-code");
      assert.equal(campus1.status, 200);
      assert.ok(campus1.data.handoffToken);
      assert.ok(campus1.data.portalQr.startsWith("data:image/png;base64,"));

      const scan1 = await fetch(base + "/m/" + encodeURIComponent(campus1.data.handoffToken), {
        redirect: "manual",
      });
      assert.equal(scan1.status, 302);
      assert.equal(scan1.headers.get("location"), "/?pm=1");
      const setCookie = scan1.headers.get("set-cookie") || "";
      assert.match(setCookie, /rjc_mobile_parent=/);
      const mobileCookie = setCookie.split(";")[0];

      // Second scan of SAME single-use token fails (410)
      const scan2 = await fetch(base + "/m/" + encodeURIComponent(campus1.data.handoffToken), {
        redirect: "manual",
      });
      assert.equal(scan2.status, 410);

      // Handoff rotated automatically on monitor
      const campus2 = await api("/api/campus-code");
      assert.notEqual(campus2.data.handoffToken, campus1.data.handoffToken);

      // Mobile parent session cannot access /admin, /api/admin/*, or kiosk print endpoints
      const mobileCfg = await api("/api/public-config", {
        headers: { Cookie: mobileCookie },
      });
      assert.equal(mobileCfg.data.mobileParentOnly, true);
      assert.equal(
        (await fetch(base + "/admin", { headers: { Cookie: mobileCookie } })).status,
        403,
      );
      assert.equal(
        (await fetch(base + "/api/admin/dashboard", { headers: { Cookie: mobileCookie, ...adminHeaders } })).status,
        403,
      );
      assert.equal(
        (await fetch(base + "/api/kiosk/print-next", { headers: { Cookie: mobileCookie } })).status,
        403,
      );

      // 3. Parent verification -> Face proof gate -> Submit Request
      const start = await api("/api/parent/start", { body: { phone: "9822011111" } });
      const verified = await api("/api/parent/family", {
        body: {
          challengeId: start.data.challengeId,
          birthMonth: "06",
          birthYear: "2013",
          grNumber: "AP-101",
        },
      });
      assert.equal(verified.status, 200);
      const session = verified.data.sessionToken;
      const studentRef = verified.data.students[0].studentRef;

      // Without face proof -> 403
      assert.equal(
        (await api("/api/parent/students", { headers: { "x-parent-session": session } })).status,
        403,
      );

      // Upload face proof
      const facePhoto = samplePngDataUrl(40, 30);
      const faceRes = await api("/api/parent/face-proof", {
        headers: { "x-parent-session": session },
        body: { photoData: facePhoto },
      });
      assert.equal(faceRes.status, 200);
      assert.equal(faceRes.data.faceVerified, true);

      const stRes = await api("/api/parent/students", {
        headers: { "x-parent-session": session },
      });
      assert.equal(stRes.status, 200);
      const bonafideTpl = stRes.data.templates.find((t) => /bonafide/i.test(t.title_en));
      assert.ok(bonafideTpl);

      // Direct document generation is blocked (403)
      const liveCode = (await api("/api/campus-code")).data.code;
      assert.equal(
        (
          await api("/api/generate-document", {
            headers: { "x-parent-session": session },
            body: { studentRef, templateId: bonafideTpl.id, campusCode: liveCode, lang: "en" },
          })
        ).status,
        403,
      );

      // Attach supporting handwritten/PDF application
      const upSess = await api("/api/parent/upload-session", {
        headers: { "x-parent-session": session },
        body: { studentRef },
      });
      const fakePdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
      await api("/api/upload/" + upSess.data.uploadToken, {
        body: {
          fileName: "handwritten-app.pdf",
          dataUrl: "data:application/pdf;base64," + fakePdf.toString("base64"),
        },
      });

      // Submit request -> lands in PENDING hold
      const submitRes = await api("/api/parent/submit-request", {
        headers: { "x-parent-session": session },
        body: {
          studentRef,
          templateId: bonafideTpl.id,
          campusCode: liveCode,
          lang: "en",
          uploadToken: upSess.data.uploadToken,
        },
      });
      assert.equal(submitRes.status, 200);
      assert.equal(submitRes.data.status, "PENDING");
      const requestId = submitRes.data.requestId;

      // Duplicate submission in same session blocked
      const liveCode2 = (await api("/api/campus-code")).data.code;
      assert.equal(
        (
          await api("/api/parent/submit-request", {
            headers: { "x-parent-session": session },
            body: { studentRef, templateId: bonafideTpl.id, campusCode: liveCode2, lang: "en" },
          })
        ).status,
        409,
      );

      // 4. Teacher Portal login & 1-of-3 atomic approval claim
      const roster = await api("/api/teacher/roster");
      assert.equal(roster.status, 200);
      assert.equal(roster.data.teachers.length, 3);

      const loginT1 = await api("/api/teacher/login", {
        body: { teacherId: t1.data.id, pin: "1111" },
      });
      const loginT2 = await api("/api/teacher/login", {
        body: { teacherId: t2.data.id, pin: "2222" },
      });
      assert.equal(loginT1.status, 200);
      assert.equal(loginT2.status, 200);

      // Both teachers can view parent face proof & attachment
      const tReqs = await api("/api/teacher/requests", {
        headers: { "x-teacher-token": loginT1.data.token },
      });
      assert.equal(tReqs.status, 200);
      const pendingRow = tReqs.data.requests.find((r) => r.id === requestId);
      assert.ok(pendingRow);
      assert.equal(pendingRow.has_supporting_doc, 1);
      assert.equal(pendingRow.parent_photo_data, facePhoto);

      const attRes = await fetch(base + `/api/teacher/requests/${requestId}/attachment`, {
        headers: { "x-teacher-token": loginT1.data.token },
      });
      assert.equal(attRes.status, 200);
      assert.deepEqual(Buffer.from(await attRes.arrayBuffer()), fakePdf);

      // Teacher 1 approves; Teacher 2 tries to approve same request -> alreadyHandled: true
      const approve1 = await api(`/api/teacher/requests/${requestId}/approve`, {
        headers: { "x-teacher-token": loginT1.data.token },
        body: {},
      });
      assert.equal(approve1.status, 200);
      assert.equal(approve1.data.alreadyHandled, false);
      assert.equal(approve1.data.request.reviewed_by_name, "Mrs. Joshi");
      const serialNo = approve1.data.request.serial_no;
      assert.ok(serialNo);

      const approve2 = await api(`/api/teacher/requests/${requestId}/approve`, {
        headers: { "x-teacher-token": loginT2.data.token },
        body: {},
      });
      assert.equal(approve2.status, 200);
      assert.equal(approve2.data.alreadyHandled, true);
      assert.equal(approve2.data.request.serial_no, serialNo);

      // 5. Connected Counter PC browser auto-print job & acknowledgement
      const printNext = await api("/api/kiosk/print-next");
      assert.equal(printNext.status, 200);
      assert.ok(printNext.data.job);
      assert.equal(printNext.data.job.requestId, requestId);
      assert.match(printNext.data.job.certificateHtml, /Approved By:\s*<strong>Mrs\. Joshi<\/strong>/);

      const ack = await api(`/api/kiosk/print-ack/${requestId}`, {
        body: { ok: true },
      });
      assert.equal(ack.status, 200);

      // Parent polling sees APPROVED + PRINTED + approver name (still no PDF download URL!)
      const pStatus = await api(`/api/parent/request-status/${requestId}`, {
        headers: { "x-parent-session": session },
      });
      assert.equal(pStatus.status, 200);
      assert.equal(pStatus.data.status, "APPROVED");
      assert.equal(pStatus.data.printStatus, "PRINTED");
      assert.equal(pStatus.data.reviewedByName, "Mrs. Joshi");

      // Parent cannot download PDF; Admin CAN download PDF
      assert.equal(
        (await fetch(base + `/api/documents/${serialNo}/pdf`, { headers: { "x-parent-session": session } })).status,
        401,
      );
      const adminPdf = await fetch(base + `/api/documents/${serialNo}/pdf`, {
        headers: adminHeaders,
      });
      assert.equal(adminPdf.status, 200);

      // 6. Personalized QR verification logs scan count + face proof + approver
      const v1 = await fetch(base + `/verify/${serialNo}`);
      assert.equal(v1.status, 200);
      const html1 = await v1.text();
      assert.match(html1, /Mrs\. Joshi/);
      assert.match(html1, /Parent \/ Family Collector/);
      assert.match(html1, />1\b/);

      const v2 = await fetch(base + `/verify/${serialNo}`);
      assert.equal(v2.status, 200);
      const html2 = await v2.text();
      assert.match(html2, />2\b/);

      const details = await api(`/api/admin/logs/${serialNo}/details`, {
        headers: adminHeaders,
      });
      assert.equal(details.status, 200);
      assert.equal(details.data.log.approved_by_name, "Mrs. Joshi");
      assert.equal(details.data.log.scan_count, 2);
      assert.equal(details.data.log.parent_photo_data, facePhoto);
      assert.equal(details.data.scans.length, 2);

      const csvRes = await fetch(base + "/api/admin/logs.csv", { headers: adminHeaders });
      const csvRows = parse(await csvRes.text(), { columns: true, bom: true });
      const row = csvRows.find((r) => r.serial_no === serialNo);
      assert.equal(row.approved_by_name, "Mrs. Joshi");
      assert.equal(row.scan_count, "2");
    } finally {
      child.kill();
      await new Promise((r) => child.once("exit", r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("Telegram bot handles /join unlimited staff, sendPhoto+sendDocument, and 1-of-N callback_query approval", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-tg-bot-"));
  const db = openDatabase(dir);
  db.prepare(
    "UPDATE school_settings SET telegram_bot_token='123:TESTBOT', staff_join_code='RJC-JOIN99' WHERE id=1",
  ).run();
  db.prepare(
    "INSERT INTO teachers(slot_number, name, role, is_top_teacher, telegram_chat_id, is_active, created_at) VALUES(1, 'Principal Rao', 'Top Teacher', 1, '555001', 1, ?)",
  ).run(new Date().toISOString());

  const calls = [];
  const fakeFetch = async (url, opts) => {
    const method = url.split("/").pop();
    calls.push({ method, body: opts?.body });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { message_id: calls.length + 100, username: "rjc_test_bot", first_name: "RJC" },
      }),
    };
  };

  try {
    const settings = () => db.prepare("SELECT * FROM school_settings WHERE id=1").get();
    const safeSettings = () => settings();
    const approvalService = createApprovalService({
      db,
      clean,
      esc,
      safeSettings,
      portalUrl: () => "http://127.0.0.1:3000",
    });
    const approvedIds = [];
    const bot = createTelegramBot({
      db,
      settings,
      approvalService,
      portalUrl: () => "http://127.0.0.1:3000",
      onApproved: (res) => approvedIds.push(res.request.id),
      fetchImpl: fakeFetch,
    });

    // Staff members join freely with /join code + full name (no limit on staff count)
    await bot.processUpdates([
      {
        update_id: 1,
        message: { chat: { id: 777001 }, from: { first_name: "Clerk" }, text: "/join RJC-JOIN99 Ramesh Clerk" },
      },
      {
        update_id: 2,
        message: { chat: { id: 777002 }, from: { first_name: "Peon" }, text: "/join RJC-JOIN99 Suresh Office" },
      },
      {
        update_id: 3,
        message: { chat: { id: 777003 }, from: { first_name: "Bad" }, text: "/join WRONG-CODE Intruder" },
      },
    ]);

    const joined = db.prepare("SELECT * FROM teachers WHERE joined_via_bot=1").all();
    assert.equal(joined.length, 2);
    assert.deepEqual(
      joined.map((t) => t.name),
      ["Ramesh Clerk", "Suresh Office"],
    );

    const student = db.prepare("SELECT * FROM students WHERE status='ACTIVE'").get();
    const tpl = db.prepare("SELECT * FROM document_templates WHERE is_active=1").get();
    const reqRow = approvalService.createRequest({
      student,
      tpl,
      lang: "en",
      verifiedPhone: student.parent_phone,
      authMethod: "family",
      isGuardian: false,
      guardianPhone: "",
      parentPhotoData: samplePngDataUrl(20, 20),
      supportingDoc: {
        fileName: "letter.png",
        mime: "image/png",
        dataUrl: samplePngDataUrl(20, 20),
      },
    });

    const sent = await bot.sendRequestNotifications(reqRow);
    // 1 top teacher + 2 joined staff = 3 recipients
    assert.equal(sent.sent, 3);
    assert.equal(calls.filter((c) => c.method === "sendPhoto").length, 3);
    assert.equal(calls.filter((c) => c.method === "sendDocument").length, 3);

    // Joined staff member approves via inline callback button; second click claims already handled
    await bot.processUpdates([
      {
        update_id: 4,
        callback_query: {
          id: "cb-1",
          from: { id: 777001 },
          message: { chat: { id: 777001 }, message_id: 105 },
          data: `approve:${reqRow.id}`,
        },
      },
      {
        update_id: 5,
        callback_query: {
          id: "cb-2",
          from: { id: 555001 },
          message: { chat: { id: 555001 }, message_id: 101 },
          data: `approve:${reqRow.id}`,
        },
      },
    ]);

    assert.deepEqual(approvedIds, [reqRow.id]);
    const finalReq = db.prepare("SELECT * FROM approval_requests WHERE id=?").get(reqRow.id);
    assert.equal(finalReq.status, "APPROVED");
    assert.equal(finalReq.reviewed_by_name, "Ramesh Clerk");
    assert.equal(finalReq.review_channel, "telegram");
    const log = db.prepare("SELECT * FROM issued_logs WHERE request_id=?").get(reqRow.id);
    assert.equal(log.approved_by_name, "Ramesh Clerk");
    assert.ok(calls.filter((c) => c.method === "editMessageCaption").length >= 3);

    // Editable bot commands: slot claim, /name, /role, /pin, /pause, /resume, /setstorage & PDF archive
    const { hashPassword } = require("../db");
    const bot2 = createTelegramBot({
      db,
      settings,
      approvalService,
      portalUrl: () => "http://127.0.0.1:3000",
      hashPassword,
      generatePdfForRequest: async () => Buffer.from("%PDF-1.4\n%test\n"),
      fetchImpl: fakeFetch,
    });
    await bot2.processUpdates([
      { update_id: 6, message: { chat: { id: 888001 }, from: { first_name: "Patil" }, text: "/join RJC-JOIN99 slot2 Mrs. Patil" } },
      { update_id: 7, message: { chat: { id: 888001 }, from: { first_name: "Patil" }, text: "/name Mrs. Sunita Patil" } },
      { update_id: 8, message: { chat: { id: 888001 }, from: { first_name: "Patil" }, text: "/role Vice Principal" } },
      { update_id: 9, message: { chat: { id: 888001 }, from: { first_name: "Patil" }, text: "/pin 4321" } },
      { update_id: 10, message: { chat: { id: 888001 }, from: { first_name: "Patil" }, text: "/pause" } },
      { update_id: 11, message: { chat: { id: 888001 }, from: { first_name: "Patil" }, text: "/resume" } },
      { update_id: 12, message: { chat: { id: -100999888 }, from: { first_name: "Admin" }, text: "/setstorage RJC-JOIN99" } },
    ]);
    const slot2Teacher = db.prepare("SELECT * FROM teachers WHERE telegram_chat_id='888001'").get();
    assert.equal(slot2Teacher.is_top_teacher, 1);
    assert.equal(slot2Teacher.slot_number, 2);
    assert.equal(slot2Teacher.name, "Mrs. Sunita Patil");
    assert.equal(slot2Teacher.role, "Vice Principal");
    assert.equal(slot2Teacher.is_active, 1);
    assert.ok(slot2Teacher.pin_hash.includes(":"));
    assert.equal(settings().telegram_storage_chat_id, "-100999888");

    const docsBefore = calls.filter((c) => c.method === "sendDocument").length;
    const photosBefore = calls.filter((c) => c.method === "sendPhoto").length;
    const archRes = await bot2.sendApprovedArchive(finalReq);
    assert.equal(archRes.sent, true);
    // Strict privacy: Bonafide PDFs MUST NOT be uploaded to Telegram
    assert.equal(calls.filter((c) => c.method === "sendDocument").length, docsBefore);
    assert.equal(calls.filter((c) => c.method === "sendPhoto").length, photosBefore + 1);
    const qrCall = calls.filter((c) => c.method === "sendPhoto").slice(-1)[0];
    const qrCaption = typeof qrCall.body?.get === "function" ? qrCall.body.get("caption") : qrCall.body?.caption;
    assert.match(qrCaption, /stays strictly on School Counter PC/i);

    // Forum Topics ("subfolders"): /settopic routes pending, approved, and scans into distinct message_thread_id values
    await bot2.processUpdates([
      { update_id: 120, message: { chat: { id: -100999888 }, message_thread_id: 101, from: { first_name: "Admin" }, text: "/settopic pending RJC-JOIN99" } },
      { update_id: 121, message: { chat: { id: -100999888 }, message_thread_id: 202, from: { first_name: "Admin" }, text: "/settopic approved RJC-JOIN99" } },
      { update_id: 122, message: { chat: { id: -100999888 }, message_thread_id: 303, from: { first_name: "Admin" }, text: "/settopic scans RJC-JOIN99" } },
    ]);
    assert.equal(settings().telegram_topic_pending, "101");
    assert.equal(settings().telegram_topic_approved, "202");
    assert.equal(settings().telegram_topic_scans, "303");

    await bot2.sendApprovedArchive(finalReq);
    const approvedTopicPhoto = calls.filter((c) => c.method === "sendPhoto").slice(-1)[0];
    const approvedThreadId =
      typeof approvedTopicPhoto.body?.get === "function"
        ? Number(approvedTopicPhoto.body.get("message_thread_id"))
        : approvedTopicPhoto.body?.message_thread_id;
    assert.equal(approvedThreadId, 202);
    await bot2.sendQrScanAlert({ ...log, scan_count: 2 });
    const scanTopicMsg = calls.filter((c) => c.method === "sendMessage").slice(-1)[0];
    const scanPayload = typeof scanTopicMsg.body === "string" ? JSON.parse(scanTopicMsg.body) : scanTopicMsg.body;
    assert.equal(scanPayload.message_thread_id, 303);

    // Interactive bare-command prompts, multi-line commands & private plain-text fallback
    const msgsBefore = calls.filter((c) => c.method === "sendMessage").length;
    await bot2.processUpdates([
      { update_id: 13, message: { chat: { id: 999001, type: "private" }, from: { first_name: "NewTeacher" }, text: "/join" } },
      { update_id: 14, message: { chat: { id: 999001, type: "private" }, from: { first_name: "NewTeacher" }, text: "RJC-JOIN99 Anita Verma" } },
      { update_id: 15, message: { chat: { id: 999001, type: "private" }, from: { first_name: "NewTeacher" }, text: "/name" } },
      { update_id: 16, message: { chat: { id: 999001, type: "private" }, from: { first_name: "NewTeacher" }, text: "Mrs. Anita Verma" } },
      { update_id: 17, message: { chat: { id: 999002, type: "private" }, from: { first_name: "Multi" }, text: "/join RJC-JOIN99 slot3 Anil Patil\n/role Senior Clerk" } },
      { update_id: 18, message: { chat: { id: 999002, type: "private" }, from: { first_name: "Multi" }, text: "/setstorage" } },
      { update_id: 19, message: { chat: { id: 999002, type: "private" }, from: { first_name: "Multi" }, text: "RJC-JOIN99" } },
      { update_id: 20, message: { chat: { id: 999003, type: "private" }, from: { first_name: "Guest" }, text: "hello" } },
    ]);
    assert.equal(calls.filter((c) => c.method === "sendMessage").length, msgsBefore + 9);
    assert.equal(db.prepare("SELECT name FROM teachers WHERE telegram_chat_id='999001'").get().name, "Mrs. Anita Verma");
    const slot3 = db.prepare("SELECT * FROM teachers WHERE telegram_chat_id='999002'").get();
    assert.equal(slot3.slot_number, 3);
    assert.equal(slot3.role, "Senior Clerk");
    assert.equal(settings().telegram_storage_chat_id, "999002");

    // Predefine a staff member in DB (no Telegram yet), then verify button selection, role tap, and slot->staff switch
    const preStaff = db
      .prepare("INSERT INTO teachers(slot_number, name, role, is_top_teacher, is_active, created_at) VALUES(0, 'Meena Office', 'Office Clerk', 0, 1, ?)")
      .run(new Date().toISOString());
    const preId = Number(preStaff.lastInsertRowid);

    await bot2.processUpdates([
      { update_id: 21, message: { chat: { id: 999004, type: "private" }, from: { first_name: "Meena" }, text: "/join RJC-JOIN99" } },
      { update_id: 22, callback_query: { id: "cb-claim", from: { id: 999004 }, message: { chat: { id: 999004 } }, data: `claim_teacher:${preId}` } },
      { update_id: 23, callback_query: { id: "cb-role", from: { id: 999004 }, message: { chat: { id: 999004 } }, data: "set_role:Principal" } },
    ]);
    const claimedMeena = db.prepare("SELECT * FROM teachers WHERE id=?").get(preId);
    assert.equal(claimedMeena.telegram_chat_id, "999004");
    assert.equal(claimedMeena.role, "Principal");

    // Predefine Top Teacher Slot 1 directly via Telegram buttons
    await bot2.processUpdates([
      { update_id: 24, message: { chat: { id: 999004, type: "private" }, from: { first_name: "Meena" }, text: "/predefine" } },
      { update_id: 25, callback_query: { id: "cb-prepos", from: { id: 999004 }, message: { chat: { id: 999004 } }, data: "predefine_pos:1" } },
      { update_id: 26, message: { chat: { id: 999004, type: "private" }, from: { first_name: "Meena" }, text: "Sunita Joshi" } },
    ]);
    const preSlot1 = db.prepare("SELECT * FROM teachers WHERE is_top_teacher=1 AND slot_number=1").get();
    assert.equal(preSlot1.name, "Sunita Joshi");
    await bot2.processUpdates([
      { update_id: 27, callback_query: { id: "cb-prerole", from: { id: 999004 }, message: { chat: { id: 999004 } }, data: `pre_role:${preSlot1.id}:Headmaster` } },
    ]);
    assert.equal(db.prepare("SELECT role FROM teachers WHERE id=?").get(preSlot1.id).role, "Headmaster");

    // Switching from Top Teacher (slot3) to Staff via /join CODE Name clears is_top_teacher and slot_number
    await bot2.processUpdates([
      { update_id: 28, message: { chat: { id: 999002, type: "private" }, from: { first_name: "Multi" }, text: "/join RJC-JOIN99 Anil Staff" } },
    ]);
    const switchedStaff = db.prepare("SELECT * FROM teachers WHERE telegram_chat_id='999002'").get();
    assert.equal(switchedStaff.is_top_teacher, 0);
    assert.equal(switchedStaff.slot_number, 0);
    assert.equal(switchedStaff.name, "Anil Staff");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
