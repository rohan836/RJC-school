const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { PNG } = require("pngjs");
const puppeteer = require("puppeteer-core");
const { openDatabase, hashPassword } = require("../db");
const { browserPath, renderCertificate } = require("../certificate");
const {
  computeVerificationSeal,
  verifyVerificationSeal,
} = require("../verification-seal");

function samplePngDataUrl(width = 24, height = 24, r = 180) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = 120;
    png.data[i + 2] = 95;
    png.data[i + 3] = 255;
  }
  return "data:image/png;base64," + PNG.sync.write(png).toString("base64");
}

test("verification-seal computes deterministic HMAC seal and detects any field tampering", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  const payload = {
    serialNo: "RJC-2026-10001",
    grNumber: "4501",
    studentName: "Aarav Patil",
    docTitle: "Bonafide Certificate",
    issuedAt: "15 Nov 2026",
    bodyHtml: "<p>This is to certify that <strong>Aarav Patil</strong> is a bonafide student.</p>",
  };

  const seal = computeVerificationSeal(secret, payload);
  assert.equal(seal.sig.length, 22);
  assert.match(seal.securityCode, /^RJC-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(seal.contentHash.length, 16);

  const validCheck = verifyVerificationSeal(secret, payload, seal.sig);
  assert.equal(validCheck.hasSig, true);
  assert.equal(validCheck.valid, true);

  // Whitespace differences in bodyHtml normalize identically, while text changes fail
  const whitespaceCheck = verifyVerificationSeal(
    secret,
    { ...payload, bodyHtml: "<p>This   is to certify that <strong>Aarav Patil</strong> is a bonafide student.</p>" },
    seal.sig,
  );
  assert.equal(whitespaceCheck.valid, true);

  const alteredName = verifyVerificationSeal(
    secret,
    { ...payload, studentName: "Rohan Patil" },
    seal.sig,
  );
  assert.equal(alteredName.valid, false);

  const alteredBody = verifyVerificationSeal(
    secret,
    { ...payload, bodyHtml: "<p>Tampered date of birth</p>" },
    seal.sig,
  );
  assert.equal(alteredBody.valid, false);

  const forgedSig = verifyVerificationSeal(secret, payload, "FORGED_BAD_SIGNATURE12");
  assert.equal(forgedSig.hasSig, true);
  assert.equal(forgedSig.valid, false);

  const unsigned = verifyVerificationSeal(secret, payload, "");
  assert.equal(unsigned.hasSig, false);
  assert.equal(unsigned.valid, false);
});

test(
  "tamper-proof QR verification & Front Panel Daily Queue pop-up end-to-end (API + desktop & mobile UI)",
  { timeout: 60000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-counter-qr-"));
    const db = openDatabase(dir);
    const adminPassword = "synthetic-counter-pass";
    db.prepare("UPDATE admin_users SET password_hash=? WHERE username='admin'").run(
      hashPassword(adminPassword),
    );
    const studentPhoto = samplePngDataUrl(20, 20, 45);
    db.prepare("DELETE FROM students").run();
    db.prepare(
      "INSERT INTO students(gr_number,full_name,father_name,class_name,division,dob,birth_year,parent_phone,photo_data,status) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "CQ-101",
      "Ananya Deshmukh",
      "Prakash Deshmukh",
      "7th",
      "A",
      "08/08/2014",
      "2014",
      "9822088888",
      studentPhoto,
      "ACTIVE",
    );
    const settingsRow = db.prepare("SELECT * FROM school_settings WHERE id=1").get();
    assert.ok(settingsRow.verification_secret && settingsRow.verification_secret.length >= 32);
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

    let browser;
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

      // Admin login & add staff teacher with PIN
      const adminLogin = await api("/api/admin/login", {
        body: { username: "admin", password: adminPassword },
      });
      const adminHeaders = { "x-admin-token": adminLogin.data.token };

      // Verify dashboard does NOT expose verification_secret
      const dash = await api("/api/admin/dashboard", { headers: adminHeaders });
      assert.equal(dash.data.settings.verification_secret, undefined);

      const staffRes = await api("/api/admin/teachers", {
        headers: adminHeaders,
        body: {
          slot_number: 1,
          name: "Mrs. Sunita Joshi",
          role: "Principal",
          is_top_teacher: true,
          pin: "4321",
        },
      });
      assert.equal(staffRes.status, 200);

      // Parent submits two requests (one with handwritten application upload, one to approve via UI pop-up)
      const collectorPhoto = samplePngDataUrl(28, 28, 195);
      const docAttachment = samplePngDataUrl(24, 24, 240);
      const tplId = dash.data.templates[0].id;

      const submitForParent = async (withUpload) => {
        const start = await api("/api/parent/start", { body: { phone: "9822088888" } });
        const fam = await api("/api/parent/family", {
          body: {
            challengeId: start.data.challengeId,
            birthMonth: "08",
            birthYear: "2014",
            grNumber: "CQ-101",
          },
        });
        const pSession = fam.data.sessionToken;
        const studentRef = fam.data.students[0].studentRef;
        await api("/api/parent/face-proof", {
          headers: { "x-parent-session": pSession },
          body: { photoData: collectorPhoto },
        });
        let uploadToken = "";
        if (withUpload) {
          const upSess = await api("/api/parent/upload-session", {
            headers: { "x-parent-session": pSession },
            body: { studentRef },
          });
          assert.equal(upSess.status, 200);
          uploadToken = upSess.data.uploadToken;
          const upRes = await api(`/api/upload/${uploadToken}`, {
            body: { fileName: "handwritten.png", dataUrl: docAttachment },
          });
          assert.equal(upRes.status, 200);
        }
        const campusCode = (await api("/api/campus-code")).data.code;
        const sub = await api("/api/parent/submit-request", {
          headers: { "x-parent-session": pSession },
          body: {
            studentRef,
            templateId: tplId,
            campusCode,
            lang: "en",
            ...(uploadToken ? { uploadToken } : {}),
          },
        });
        assert.equal(sub.status, 200);
        return sub.data.requestId;
      };

      const reqId1 = await submitForParent(true);
      const reqId2 = await submitForParent(false);

      // 1. Unauthenticated /api/counter/requests is blocked (401)
      const unauthCounter = await api("/api/counter/requests");
      assert.equal(unauthCounter.status, 401);

      // 2. Staff PIN unlocks counter desk and lists both today's requests
      const staffLogin = await api("/api/teacher/login", {
        body: { teacherId: staffRes.data.id, pin: "4321" },
      });
      const staffHeaders = { "x-teacher-token": staffLogin.data.token };

      // Verify mobile parent QR handoff cookie blocks counter APIs (403)
      const qrHandoff = await api("/api/campus-code");
      const handoffRes = await fetch(base + `/m/${qrHandoff.data.handoffToken}`, { redirect: "manual" });
      const cookieHeader = (handoffRes.headers.get("set-cookie") || "").split(";")[0];
      assert.ok(cookieHeader.includes("rjc_mobile_parent="));
      const blockedMobile = await api("/api/counter/requests", {
        headers: { ...staffHeaders, cookie: cookieHeader },
      });
      assert.equal(blockedMobile.status, 403);

      const queueBefore = await api("/api/counter/requests?scope=today", { headers: staffHeaders });
      assert.equal(queueBefore.status, 200);
      assert.equal(queueBefore.data.summary.pendingToday, 2);
      assert.equal(queueBefore.data.requests.length, 2);

      // Attachment endpoint returns raw uploaded application bytes with filename header
      const attRes = await fetch(base + `/api/counter/requests/${reqId1}/attachment`, {
        headers: staffHeaders,
      });
      assert.equal(attRes.status, 200);
      const attBytes = Buffer.from(await attRes.arrayBuffer());
      const expectedBytes = Buffer.from(docAttachment.split(",")[1], "base64");
      assert.equal(attBytes.equals(expectedBytes), true);

      // Approve reqId1 via counter API -> produces serial_no + signed verification_url + security_code
      const app1 = await api(`/api/counter/requests/${reqId1}/approve`, {
        headers: staffHeaders,
        body: { remarks: "Verified at counter" },
      });
      assert.equal(app1.status, 200);
      const serial1 = app1.data.request.serial_no;
      assert.ok(serial1);

      const queueAfterApprove = await api("/api/counter/requests?scope=today", { headers: staffHeaders });
      const row1 = queueAfterApprove.data.requests.find((r) => r.id === reqId1);
      assert.match(row1.security_code, /^RJC-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      assert.ok(row1.verification_url.includes(`/verify/${serial1}?v=`));

      // Verify certificate HTML renders the tamper-proof footer label & Seal ID
      const certSample = renderCertificate({
        serialNo: serial1,
        issuedAt: "15 Nov 2026",
        docTitle: "Bonafide Certificate",
        bodyHtml: "<p>Original test certificate</p>",
        sigPos: "right",
        stampPos: "right",
        lang: "en",
        settings: { school_name: "R. J. Chaware Convent" },
        student: { full_name: "Ananya Deshmukh", gr_number: "CQ-101", class_name: "7th", division: "A" },
        verificationUrl: base + row1.verification_url,
        verificationQr: "data:image/png;base64,AAA",
        securityCode: row1.security_code,
      });
      assert.match(certSample.certificateBody, /Official School Verification Record/);
      assert.match(certSample.certificateBody, /Tamper-proof QR/);
      assert.ok(certSample.certificateBody.includes(row1.security_code));

      // 3. Tampered signature on /verify/:serial returns 403 and blocks body + does NOT increment scans
      const tamperedRes = await fetch(`${base}/verify/${serial1}?v=BADTAMPEREDSIG0000000`);
      assert.equal(tamperedRes.status, 403);
      const tamperedHtml = await tamperedRes.text();
      assert.match(tamperedHtml, /Invalid or tampered verification QR/);
      assert.equal(tamperedHtml.includes("Ananya Deshmukh"), false);
      assert.equal(tamperedHtml.includes(collectorPhoto), false);

      // 4. Valid signed URL returns 200, shows CRYPTOGRAPHIC SEAL VERIFIED + Original Authentic Document
      const validVerifyRes = await fetch(`${base}${row1.verification_url}`);
      assert.equal(validVerifyRes.status, 200);
      const validVerifyHtml = await validVerifyRes.text();
      assert.match(validVerifyHtml, /CRYPTOGRAPHIC SEAL VERIFIED/);
      assert.match(validVerifyHtml, /Original Authentic Document/);
      assert.ok(validVerifyHtml.includes(row1.security_code));
      assert.match(validVerifyHtml, /Ananya Deshmukh/);
      assert.ok(validVerifyHtml.includes(collectorPhoto));
      assert.equal(validVerifyHtml.includes(studentPhoto), false);

      // Scan count must be 1 (tampered scan did NOT count)
      const logDetails = await api(`/api/admin/logs/${serial1}/details`, { headers: adminHeaders });
      assert.equal(logDetails.data.log.scan_count, 1);

      // 5. Headless UI test on Front Panel (1440px & 390px) for Daily Queue Pop-Up
      browser = await puppeteer.launch({
        executablePath: browserPath(),
        headless: true,
        args: process.platform === "linux" ? ["--no-sandbox"] : [],
      });
      const page = await browser.newPage();
      const pageErrors = [];
      page.on("pageerror", (e) => pageErrors.push(e.message));

      // Desktop 1440x900: open via #front-desk-btn, unlock with Staff PIN, approve reqId2
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(base, { waitUntil: "networkidle0" });
      await page.waitForSelector("#front-desk-btn");
      await page.click("#front-desk-btn");
      await page.waitForSelector("#counter-desk-backdrop:not([hidden])");

      await page.waitForSelector('#desk-teacher-select option[value="' + String(staffRes.data.id) + '"]');
      await page.select("#desk-teacher-select", String(staffRes.data.id));
      await page.type("#desk-teacher-pin", "4321");
      await page.click("#desk-teacher-form button.primary");

      await page.waitForSelector(`#desk-list .desk-row[data-req-id="${reqId2}"]`);
      const summaryPending = await page.$eval("#desk-sum-pending", (el) => el.textContent.trim());
      assert.equal(summaryPending, "1");

      // Approve reqId2 directly inside Front Panel pop-up
      await page.click(`#desk-list .desk-row[data-req-id="${reqId2}"] button[data-desk-approve="${reqId2}"]`);
      await page.waitForFunction(
        () => document.getElementById("desk-sum-pending")?.textContent?.trim() === "0",
        { timeout: 10000 },
      );

      // Verify signed QR link exists on approved row & desktop modal fits without page horizontal overflow
      const hasVerifyLink = await page.$eval(
        `#desk-list .desk-row[data-req-id="${reqId1}"] a[href*="/verify/${serial1}?v="]`,
        (el) => el.getAttribute("href"),
      );
      assert.ok(hasVerifyLink.includes("?v="));
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );

      // Lock desk returns to unlock screen
      await page.click("#desk-lock-btn");
      await page.waitForSelector("#desk-unlock-view:not([hidden])");
      await page.click("#desk-close-btn");
      await page.waitForSelector("#counter-desk-backdrop[hidden]");

      // Mobile 390x844: open via #front-desk-mobile-btn, zero horizontal overflow
      await page.setViewport({ width: 390, height: 844 });
      await page.goto(base, { waitUntil: "networkidle0" });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.click("#front-desk-mobile-btn");
      await page.waitForSelector("#counter-desk-backdrop:not([hidden])");
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.equal(pageErrors.length, 0);
    } finally {
      if (browser) await browser.close();
      child.kill();
      await new Promise((r) => child.once("exit", r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Bonafide-only default, Original vs Duplicate print stamps, print_logs, collector role, reason & campus code",
  { timeout: 60000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-orig-dup-"));
    const db = openDatabase(dir);
    const adminPassword = "synthetic-orig-pass";
    db.prepare("UPDATE admin_users SET password_hash=? WHERE username='admin'").run(
      hashPassword(adminPassword),
    );
    // Verify Migration 3 leaves only Bonafide Certificate active by default while preserving all 3 seeded templates in DB
    const allTemplates = db.prepare("SELECT title_en, is_active FROM document_templates ORDER BY id").all();
    assert.equal(allTemplates.length, 3);
    const activeTemplates = allTemplates.filter((t) => t.is_active === 1);
    assert.equal(activeTemplates.length, 1);
    assert.equal(activeTemplates[0].title_en, "Bonafide Certificate");

    db.prepare("DELETE FROM students").run();
    db.prepare(
      "INSERT INTO students(gr_number,full_name,father_name,class_name,division,dob,birth_year,parent_phone,status) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run("OD-1", "Vivaan Kale", "Sanjay Kale", "6th", "B", "12/03/2015", "2015", "9822099999", "ACTIVE");
    db.close();

    // Unit-check ORIGINAL vs DUPLICATE HTML stamp rendering
    const origCert = renderCertificate({
      serialNo: "RJC-2026-20001",
      issuedAt: "15 Nov 2026",
      docTitle: "Bonafide Certificate",
      bodyHtml: "<p>Original test</p>",
      sigPos: "right",
      stampPos: "right",
      lang: "en",
      settings: { school_name: "R. J. Chaware Convent" },
      student: { full_name: "Vivaan Kale", gr_number: "OD-1", class_name: "6th", division: "B" },
      verificationUrl: "https://example.school/verify/RJC-2026-20001?v=abc",
      verificationQr: "data:image/png;base64,AAA",
      securityCode: "RJC-AAAA-BBBB",
      copyNumber: 1,
      printerName: "HP LaserJet Counter",
      collectorLabel: "Parent / Family Collector",
    });
    assert.match(origCert.certificateBody, /ORIGINAL · PAGE 1 OF 1 \(SHEET #01\)/);
    assert.equal(origCert.certificateBody.includes("dup-watermark"), false);
    assert.equal(origCert.certificateBody.includes("page-stamp"), false);
    assert.match(origCert.certificateBody, /Original Record · Sheet #01/);
    assert.match(origCert.certificateBody, /HP LaserJet Counter/);
    assert.match(origCert.certificateBody, /Parent \/ Family Collector/);

    const dupCert = renderCertificate({
      serialNo: "RJC-2026-20001",
      issuedAt: "15 Nov 2026",
      docTitle: "Bonafide Certificate",
      bodyHtml: "<p>Duplicate test</p>",
      sigPos: "right",
      stampPos: "right",
      lang: "en",
      settings: { school_name: "R. J. Chaware Convent" },
      student: { full_name: "Vivaan Kale", gr_number: "OD-1", class_name: "6th", division: "B" },
      verificationUrl: "https://example.school/verify/RJC-2026-20001?v=abc",
      verificationQr: "data:image/png;base64,AAA",
      securityCode: "RJC-AAAA-BBBB",
      copyNumber: 2,
      pageNo: "Page 1 of 1 (Sheet #02)",
      printSecurityCode: "PRT-02-1234-5678",
      printerName: "HP LaserJet Counter",
      collectorLabel: "Authorized Guardian",
    });
    assert.match(dupCert.certificateBody, /DUPLICATE #2 · PAGE 1 OF 1 \(SHEET #02\)/);
    assert.equal(dupCert.certificateBody.includes("dup-watermark"), false);
    assert.equal(dupCert.certificateBody.includes("page-stamp"), false);
    assert.match(dupCert.certificateBody, /Duplicate Copy \(#2\) · Sheet #02/);
    assert.match(dupCert.certificateBody, /PRT-02-1234-5678/);
    assert.match(dupCert.certificateBody, /Authorized Guardian/);

    // Integration test over HTTP: submit with reason + campus code, approve, print #1 (ORIGINAL), reprint #2 (DUPLICATE #2)
    const socket = net.createServer();
    await new Promise((r) => socket.listen(0, "127.0.0.1", r));
    const port = socket.address().port;
    await new Promise((r) => socket.close(r));

    const child = spawn(process.execPath, ["server.js"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", KIOSK_DATA_DIR: dir },
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
      return { status: res.status, data };
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

      const adminLogin = await api("/api/admin/login", { body: { username: "admin", password: adminPassword } });
      const adminHeaders = { "x-admin-token": adminLogin.data.token };
      await api("/api/admin/telegram/settings", {
        headers: adminHeaders,
        body: { printer_name: "Canon Office Printer", staff_join_code: "RJC2026" },
      });

      const start = await api("/api/parent/start", { body: { phone: "9822099999" } });
      const fam = await api("/api/parent/family", {
        body: { challengeId: start.data.challengeId, birthMonth: "03", birthYear: "2015", grNumber: "OD-1" },
      });
      const pSession = fam.data.sessionToken;
      const studentRef = fam.data.students[0].studentRef;
      await api("/api/parent/face-proof", {
        headers: { "x-parent-session": pSession },
        body: { photoData: samplePngDataUrl(24, 24, 150) },
      });
      const ps = await api("/api/parent/students", {
        headers: { "x-parent-session": pSession },
      });
      assert.equal(ps.status, 200);
      assert.equal(ps.data.templates.length, 1);
      assert.equal(ps.data.templates[0].title_en, "Bonafide Certificate");
      const campusCode = (await api("/api/campus-code")).data.code;
      const sub = await api("/api/parent/submit-request", {
        headers: { "x-parent-session": pSession },
        body: {
          studentRef,
          templateId: ps.data.templates[0].id,
          campusCode,
          reason: "Post-Matric Scholarship",
          lang: "en",
        },
      });
      assert.equal(sub.status, 200);
      const reqId = sub.data.requestId;

      const appRes = await api(`/api/counter/requests/${reqId}/approve`, {
        headers: adminHeaders,
        body: {},
      });
      assert.equal(appRes.status, 200);
      const serial = appRes.data.request.serial_no;

      // Print #1 via browser kiosk endpoint
      const job1 = await api("/api/kiosk/print-next");
      assert.equal(job1.data.job.requestId, reqId);
      assert.equal(job1.data.job.copyNumber, 1);
      assert.match(job1.data.job.certificateBody, /ORIGINAL · PAGE 1 OF 1 \(SHEET #01\)/);
      await api(`/api/kiosk/print-ack/${reqId}`, { body: { printedBy: "Office Counter PC" } });

      // Reprint #2 via Counter Desk API
      await api(`/api/counter/requests/${reqId}/reprint`, { headers: adminHeaders, body: {} });
      const job2 = await api("/api/kiosk/print-next");
      assert.equal(job2.data.job.requestId, reqId);
      assert.equal(job2.data.job.copyNumber, 2);
      assert.match(job2.data.job.certificateBody, /DUPLICATE #2 · PAGE 1 OF 1 \(SHEET #02\)/);
      await api(`/api/kiosk/print-ack/${reqId}`, { body: { printedBy: "Office Counter PC" } });

      // Verify audit trail & print_logs in Admin Log Details (including per-print 2FA code & page number)
      const details = await api(`/api/admin/logs/${serial}/details`, { headers: adminHeaders });
      assert.equal(details.data.log.reason, "Post-Matric Scholarship");
      assert.equal(details.data.log.campus_code_used, campusCode);
      assert.equal(details.data.log.collector_label, "Parent / Family Collector");
      assert.equal(details.data.log.print_count, 2);
      assert.equal(details.data.log.printer_name, "Canon Office Printer");
      assert.equal(details.data.printHistory.length, 2);
      assert.equal(details.data.printHistory[0].copy_label, "ORIGINAL");
      assert.match(details.data.printHistory[0].print_security_code, /^PRT-01-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      assert.match(details.data.printHistory[0].page_no, /Page 1 of 1 \(Sheet #01\)/);
      assert.equal(details.data.printHistory[1].copy_label, "DUPLICATE #2");
      assert.match(details.data.printHistory[1].print_security_code, /^PRT-02-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      assert.match(details.data.printHistory[1].page_no, /Page 1 of 1 \(Sheet #02\)/);
      assert.equal(details.data.log.last_print_code, details.data.printHistory[1].print_security_code);

      // Verify /verify/:serial shows collector role, purpose, physical print summary, and 2FA Print Code cross-check
      const sigParam = encodeURIComponent(details.data.log.doc_signature);
      const code1 = details.data.printHistory[0].print_security_code;
      const vRes = await fetch(`${base}/verify/${serial}?v=${sigParam}&code=${encodeURIComponent(code1)}`);
      const vHtml = await vRes.text();
      assert.match(vHtml, /Parent \/ Family Collector/);
      assert.match(vHtml, /Post-Matric Scholarship/);
      assert.match(vHtml, /2 Physical Sheets · 1 Original \+ 1 Duplicate/);
      assert.match(vHtml, /Canon Office Printer/);
      assert.match(vHtml, /AUTHENTIC PRINT SHEET MATCHED:.*Copy #1/);
      assert.ok(vHtml.includes(code1));
    } finally {
      child.kill();
      await new Promise((r) => child.once("exit", r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

