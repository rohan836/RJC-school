const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { openDatabase, hashPassword } = require("../db");

test(
  "RJC School — Permanent domain architecture, dual-domain routing & security lockdown",
  { timeout: 60000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-permanent-domain-"));
    const db = openDatabase(dir);
    const adminPassword = "synthetic-admin-pass-2026";
    db.prepare("UPDATE admin_users SET password_hash=? WHERE username='admin'").run(
      hashPassword(adminPassword),
    );

    // Seed school settings with custom permanent domains
    const portalDomain = "rjcschool.in";
    const verifyDomain = "verify.rjcschool.in";

    db.prepare(
      `UPDATE school_settings SET 
        public_url=?, 
        public_verify_url=?, 
        allow_public_teacher=0 
       WHERE id=1`,
    ).run(`https://${portalDomain}`, `https://${verifyDomain}`);

    // Seed a student and an approved certificate record for verification testing
    db.prepare("DELETE FROM students").run();
    db.prepare(
      "INSERT INTO students(gr_number, full_name, father_name, class_name, division, dob, birth_year, parent_phone, status) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run("4501", "Aarav Patil", "Sunil Patil", "8th", "A", "14/06/2013", "2013", "9822012345", "ACTIVE");

    const sampleSerial = "BON-2026-0042";
    db.prepare(
      `INSERT INTO issued_logs(
        serial_no, gr_number, student_name, doc_title, verified_phone,
        is_guardian, issued_at, doc_signature, security_code, print_count, printer_name
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      sampleSerial,
      "4501",
      "Aarav Patil",
      "Bonafide Certificate",
      "9822012345",
      0,
      new Date().toISOString(),
      "sig_test_abc123",
      "SEC-8888",
      1,
      "School Counter Desk",
    );

    db.close();

    // Find a free port
    const socket = net.createServer();
    await new Promise((r) => socket.listen(0, "127.0.0.1", r));
    const port = socket.address().port;
    await new Promise((r) => socket.close(r));

    const child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
      cwd: dir,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        KIOSK_DATA_DIR: dir,
        PUBLIC_PORTAL_URL: `https://${portalDomain}`,
        PUBLIC_VERIFY_URL: `https://${verifyDomain}`,
      },
      stdio: "ignore",
    });

    const base = `http://127.0.0.1:${port}`;

    const requestWithHost = (reqPath, hostHeader, options = {}) =>
      new Promise((resolve, reject) => {
        const method = options.method || (options.body === undefined ? "GET" : "POST");
        const headers = {
          Host: hostHeader,
          ...(options.headers || {}),
        };
        if (options.body !== undefined && !headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: reqPath,
            method,
            headers,
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
              let parsed = body;
              try {
                parsed = JSON.parse(body);
              } catch {}
              resolve({
                status: res.statusCode,
                body,
                data: parsed,
                headers: res.headers,
              });
            });
          },
        );
        req.on("error", reject);
        if (options.body !== undefined) {
          req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
        }
        req.end();
      });

    try {
      // 1. Wait for server readiness
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          const res = await fetch(`${base}/api/health`);
          if (res.ok) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(ready, "Server started and health check responded");

      // 2. Test Localhost / LAN Access (Unrestricted Staff Access)
      const localAdmin = await requestWithHost("/admin", "localhost");
      assert.equal(localAdmin.status, 200, "Localhost can access /admin");

      const localCampusCode = await requestWithHost("/api/campus-code", "localhost");
      assert.equal(localCampusCode.status, 200, "Localhost can access /api/campus-code");
      assert.ok(localCampusCode.data.code, "Local campus code is present");

      const localKiosk = await requestWithHost("/kiosk", "localhost");
      assert.equal(localKiosk.status, 200, "Localhost can access /kiosk");

      const localStaffHost = await requestWithHost("/staff-host", "localhost");
      assert.equal(localStaffHost.status, 200, "Localhost can access /staff-host");

      const localTeacher = await requestWithHost("/teacher", "localhost");
      assert.equal(localTeacher.status, 200, "Localhost can access /teacher");

      // 3. Test Public Portal Domain (https://rjcschool.in) Security Lockdown
      const publicParent = await requestWithHost("/", portalDomain);
      assert.equal(publicParent.status, 200, "Public host can access parent portal root");

      const publicConfig = await requestWithHost("/api/public-config", portalDomain);
      assert.equal(publicConfig.status, 200, "Public host can access /api/public-config");
      assert.equal(publicConfig.data.portalUrl, `https://${portalDomain}`);

      // Strict blocks on public host:
      const blockAdmin = await requestWithHost("/admin", portalDomain);
      assert.equal(blockAdmin.status, 403, "Public host is blocked from /admin");

      const blockStaffHost = await requestWithHost("/staff-host", portalDomain);
      assert.equal(blockStaffHost.status, 403, "Public host is blocked from /staff-host");

      const blockKiosk = await requestWithHost("/kiosk", portalDomain);
      assert.equal(blockKiosk.status, 403, "Public host is blocked from /kiosk");

      const blockParentScreen = await requestWithHost("/parent-screen", portalDomain);
      assert.equal(blockParentScreen.status, 403, "Public host is blocked from /parent-screen");

      const blockCampusCode = await requestWithHost("/api/campus-code", portalDomain);
      assert.equal(blockCampusCode.status, 403, "Public host is blocked from /api/campus-code");

      const blockAdminApi = await requestWithHost("/api/admin/dashboard", portalDomain);
      assert.equal(blockAdminApi.status, 403, "Public host is blocked from /api/admin/dashboard");

      // Teacher panel is private by default
      const blockTeacher = await requestWithHost("/teacher", portalDomain);
      assert.equal(blockTeacher.status, 403, "Public host is blocked from /teacher by default");

      const blockTeacherApi = await requestWithHost("/api/teacher/roster", portalDomain);
      assert.equal(blockTeacherApi.status, 403, "Public host is blocked from /api/teacher/roster by default");

      // Cloudflare header spoofing test (cf-ray attached on localhost request still triggers public isolation)
      const cfRayBlocked = await requestWithHost("/admin", "localhost", {
        headers: { "cf-ray": "1234567890abcdef" },
      });
      assert.equal(cfRayBlocked.status, 403, "Requests with cf-ray are isolated as public requests");

      // 4. Test Dedicated Verification Domain (https://verify.rjcschool.in)
      // Root / on verify domain serves dedicated Verification Lookup page
      const verifyRoot = await requestWithHost("/", verifyDomain);
      assert.equal(verifyRoot.status, 200, "Verify domain root loads verification page");
      assert.match(verifyRoot.body, /Official Verification Portal/i);
      assert.match(verifyRoot.body, /Certificate Reference \/ Serial Number/i);

      // Clean /:serial route on verify domain
      const verifyClean = await requestWithHost(`/${sampleSerial}`, verifyDomain);
      assert.equal(verifyClean.status, 200, "Clean /:serial route loads certificate verification");
      assert.match(verifyClean.body, /Verified school record/i);
      assert.match(verifyClean.body, /Aarav Patil/i);

      // /verify/:serial route on verify domain (backward compatibility)
      const verifyStandard = await requestWithHost(`/verify/${sampleSerial}`, verifyDomain);
      assert.equal(verifyStandard.status, 200, "/verify/:serial also works on verify domain");
      assert.match(verifyStandard.body, /Verified school record/i);

      // API lookup endpoint /api/verify-lookup
      const verifyLookupApi = await requestWithHost("/api/verify-lookup", verifyDomain, {
        method: "POST",
        body: { serial: sampleSerial },
      });
      assert.equal(verifyLookupApi.status, 200, "/api/verify-lookup returns verified record");
      assert.equal(verifyLookupApi.data.found, true);
      assert.equal(verifyLookupApi.data.student_name, "Aarav Patil");
      assert.equal(verifyLookupApi.data.serial_no, sampleSerial);
      assert.ok(verifyLookupApi.data.verify_url.includes(verifyDomain), "Verify URL uses verification domain");

      // Verify domain blocks non-verification interfaces
      const verifyBlockAdmin = await requestWithHost("/admin", verifyDomain);
      assert.equal(verifyBlockAdmin.status, 403, "Verify domain blocks /admin");

      const verifyBlockKiosk = await requestWithHost("/kiosk", verifyDomain);
      assert.equal(verifyBlockKiosk.status, 403, "Verify domain blocks /kiosk");

      // 5. Test Teacher Access Toggle via Admin Settings
      // Login as admin on localhost
      const loginRes = await requestWithHost("/api/admin/login", "localhost", {
        method: "POST",
        body: { username: "admin", password: adminPassword },
      });
      assert.equal(loginRes.status, 200);
      const adminToken = loginRes.data.token;
      assert.ok(adminToken);

      // Update settings: allow_public_teacher = 1
      const updateSettings = await requestWithHost("/api/admin/settings", "localhost", {
        method: "POST",
        headers: { "x-admin-token": adminToken },
        body: {
          public_url: `https://${portalDomain}`,
          public_verify_url: `https://${verifyDomain}`,
          allow_public_teacher: 1,
        },
      });
      assert.equal(updateSettings.status, 200, "Admin updated settings to allow public teacher");

      // Verify teacher panel is now accessible via public portal domain
      const teacherPublicAllowed = await requestWithHost("/teacher", portalDomain);
      assert.equal(teacherPublicAllowed.status, 200, "Teacher panel accessible on public host when allowed");

      const teacherRosterAllowed = await requestWithHost("/api/teacher/roster", portalDomain);
      assert.equal(teacherRosterAllowed.status, 200, "Teacher roster accessible on public host when allowed");

      // But /admin and /staff-host and /kiosk STILL remain strictly 403!
      assert.equal((await requestWithHost("/admin", portalDomain)).status, 403);
      assert.equal((await requestWithHost("/staff-host", portalDomain)).status, 403);
      assert.equal((await requestWithHost("/kiosk", portalDomain)).status, 403);
      assert.equal((await requestWithHost("/api/campus-code", portalDomain)).status, 403);

      // 6. Test System Diagnostics API (/api/admin/system/status)
      const statusRes = await requestWithHost("/api/admin/system/status", "localhost", {
        headers: { "x-admin-token": adminToken },
      });
      assert.equal(statusRes.status, 200, "System status API returns 200 for admin");
      const statusData = statusRes.data;
      assert.equal(statusData.ok, true);
      assert.equal(statusData.server.status, "running");
      assert.equal(statusData.database.status, "healthy");
      assert.equal(statusData.database.studentCount, 1);
      assert.equal(statusData.network.portalUrl, `https://${portalDomain}`);
      assert.equal(statusData.network.verifyUrl, `https://${verifyDomain}`);
      assert.equal(statusData.network.allowPublicTeacher, true);
      assert.ok("cloudflare" in statusData, "Diagnostics reports cloudflare state");
      assert.ok("internet" in statusData, "Diagnostics reports internet state");
    } finally {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill();
        await exited;
      }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
);
