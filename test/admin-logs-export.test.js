const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { parse } = require("csv-parse/sync");
const { openDatabase, hashPassword } = require("../db");

test(
  "admin can export issued logs CSV safely and verify page uses paper design",
  { timeout: 30000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-logs-export-"));
    const db = openDatabase(dir);
    const adminPassword = "synthetic-logs-password";
    db.prepare("UPDATE admin_users SET password_hash=? WHERE username='admin'").run(
      hashPassword(adminPassword),
    );
    db.prepare(
      "INSERT INTO issued_logs(serial_no,gr_number,student_name,doc_title,verified_phone,is_guardian,issued_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      "RJC-2026-88001",
      "4501",
      "=Aarav, \"Sunil\" Patil",
      "Bonafide Certificate",
      "9800000001",
      0,
      "2026-06-15T10:00:00.000Z",
    );
    db.prepare(
      "INSERT INTO issued_logs(serial_no,gr_number,student_name,doc_title,verified_phone,is_guardian,issued_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      "RJC-2026-88002",
      "4502",
      "Riya Rajesh Deshmukh",
      "स्थानांतरण प्रमाणपत्र",
      "9800000002",
      1,
      "2026-06-16T11:30:00.000Z",
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

      const unauth = await fetch(base + "/api/admin/logs.csv");
      assert.equal(unauth.status, 401);

      const loginRes = await fetch(base + "/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: adminPassword }),
      });
      assert.equal(loginRes.status, 200);
      const { token } = await loginRes.json();

      const csvRes = await fetch(base + "/api/admin/logs.csv", {
        headers: { "x-admin-token": token },
      });
      assert.equal(csvRes.status, 200);
      assert.match(csvRes.headers.get("content-disposition") || "", /issued-logs\.csv/);
      assert.match(csvRes.headers.get("content-type") || "", /text\/csv/);

      const rawBuf = Buffer.from(await csvRes.arrayBuffer());
      assert.deepEqual(rawBuf.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
      const csvText = rawBuf.toString("utf8");
      const records = parse(csvText, { columns: true, bom: true });
      assert.equal(records.length, 2);
      assert.equal(records[0].serial_no, "RJC-2026-88002");
      assert.equal(records[0].is_guardian, "Yes");
      assert.equal(records[0].doc_title, "स्थानांतरण प्रमाणपत्र");
      assert.equal(records[1].serial_no, "RJC-2026-88001");
      assert.equal(records[1].student_name, '\'=Aarav, "Sunil" Patil');
      assert.equal(records[1].is_guardian, "No");

      const filteredRes = await fetch(base + "/api/admin/logs.csv?q=88002", {
        headers: { "x-admin-token": token },
      });
      assert.equal(filteredRes.status, 200);
      const filteredRows = parse(await filteredRes.text(), { columns: true, bom: true });
      assert.equal(filteredRows.length, 1);
      assert.equal(filteredRows[0].serial_no, "RJC-2026-88002");

      const verifyOk = await fetch(base + "/verify/RJC-2026-88002");
      assert.equal(verifyOk.status, 200);
      const verifyHtml = await verifyOk.text();
      assert.match(verifyHtml, /School record found/);
      assert.match(verifyHtml, /#f3f2ee/i);
      assert.doesNotMatch(verifyHtml, /border-radius:\s*24px/i);

      const verifyMissing = await fetch(base + "/verify/RJC-2026-99999");
      assert.equal(verifyMissing.status, 404);
      assert.match(await verifyMissing.text(), /Record not found/);
    } finally {
      child.kill("SIGTERM");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
