const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const QR = require("jsqr");
const { PNG } = require("pngjs");
const puppeteer = require("puppeteer-core");
const { browserPath } = require("../certificate");
const decode = (url) => {
  const p = PNG.sync.read(Buffer.from(url.split(",")[1], "base64"));
  return QR(new Uint8ClampedArray(p.data), p.width, p.height)?.data;
};
test(
  "complete offline portal, admin routes, LAN security, rendering and durable data",
  { timeout: 120000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rgc-test-"));
    const port = 20000 + Math.floor(Math.random() * 20000);
    let child;
    const start = async () => {
      child = spawn(process.execPath, ["server.js"], {
        env: {
          ...process.env,
          PORT: String(port),
          HOST: "0.0.0.0",
          KIOSK_DATA_DIR: dir,
          WHATSAPP_APP_SECRET: "test-secret",
          WHATSAPP_VERIFY_TOKEN: "test-verify",
          WHATSAPP_TOKEN: "",
          PHONE_NUMBER_ID: "",
        },
        stdio: "ignore",
      });
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(base + "/api/health")).ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      throw Error("Server did not start");
    };
    const stop = async () => {
      const done = new Promise((r) => child.once("exit", r));
      child.kill();
      await done;
    };
    const base = `http://127.0.0.1:${port}`;
    let token = "";
    const req = async (url, method = "GET", body, auth = true) => {
      const r = await fetch(base + url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(auth && token ? { "x-admin-token": token } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, data: await r.json() };
    };
    const login = async (password = "school1234") => {
      const r = await req("/api/admin/login", "POST", {
        username: "admin",
        password,
      });
      assert.equal(r.status, 200);
      token = r.data.token;
    };
    try {
      await start();
      assert.equal((await req("/api/health")).data.journalMode, "wal");
      assert.equal((await req("/api/health")).data.synchronous, 2);
      assert.equal((await req("/api/admin/dashboard")).status, 401);
      await login();
      let dashboard = (await req("/api/admin/dashboard")).data;
      assert.equal(dashboard.students.length, 5);
      assert.equal(dashboard.templates.length, 3);
      assert.ok(
        dashboard.students.every((s) => /^\d{4}$/.test(s.aadhaar_last4)),
      );
      assert.ok(fs.existsSync(path.join(dir, "admin-credentials.txt")));
      const config = (await req("/api/public-config")).data;
      assert.ok(config.isLocalKiosk);
      assert.ok(!JSON.stringify(config).includes("aadhaar"));
      const found = (
        await req("/api/search-student", "POST", {
          mode: "phone",
          phone: "9822011111",
        })
      ).data.students;
      assert.equal(found[0].masked_phone, "******1111");
      assert.equal(found[0].aadhaar_last4, undefined);
      assert.equal(found[0].parent_phone, undefined);
      assert.equal(
        (
          await req("/api/search-student", "POST", {
            mode: "name",
            query: "Su",
            className: "8th",
            division: "A",
          })
        ).data.students.length,
        1,
      );
      assert.equal(
        (
          await req("/api/search-student", "POST", {
            mode: "name",
            query: "Su",
            division: "B",
          })
        ).data.students.length,
        0,
      );
      let c = (await req("/api/campus-code")).data;
      assert.match(c.lanIp, /^(localhost|\d+\.\d+\.\d+\.\d+)$/);
      assert.equal(decode(c.portalQr), c.portalLink);
      assert.equal(c.wifiQr, null);
      const png =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4O0AAAAASUVORK5CYII=";
      assert.equal(
        (
          await req("/api/admin/settings", "POST", {
            wifi_ssid: "School;WiFi",
            wifi_password: "pass:1234",
            logo_data: png,
            signature_data: png,
            stamp_data: png,
          })
        ).status,
        200,
      );
      c = (await req("/api/campus-code")).data;
      assert.equal(
        decode(c.wifiQr),
        "WIFI:T:WPA;S:School\\;WiFi;P:pass\\:1234;;",
      );
      const tpl = config.templates[0].id,
        payload = { grNumber: "4501", templateId: tpl, birthYear: "2013" };
      assert.equal(
        (
          await req("/api/generate-document", "POST", {
            ...payload,
            campusCode: "0000",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await req("/api/generate-document", "POST", {
            ...payload,
            isLocalKiosk: true,
            birthYear: "2000",
          })
        ).status,
        401,
      );
      const issued = await req("/api/generate-document", "POST", {
        ...payload,
        campusCode: c.code,
        lang: "mr",
      });
      assert.equal(issued.status, 200);
      assert.match(issued.data.serialNo, /^RGC-\d{4}-\d{5}$/);
      assert.match(issued.data.bodyHtml, /प्रमाणित/);
      assert.ok(
        !JSON.stringify(issued.data.settings).includes("wifi_password"),
      );
      assert.ok(issued.data.certificateHtml.includes("data:font/woff2"));
      assert.ok(issued.data.certificateHtml.includes("data:image/png;base64"));
      assert.notEqual((await req("/api/campus-code")).data.code, c.code);
      assert.equal(
        (
          await req("/api/generate-document", "POST", {
            ...payload,
            campusCode: c.code,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await req("/api/generate-document", "POST", {
            ...payload,
            verificationMode: "backup",
            birthYear: "",
            confirmGr: "4501",
            aadhaarLast4: "1234",
            isLocalKiosk: true,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await req("/api/generate-document", "POST", {
            ...payload,
            isGuardian: true,
            guardianPhone: "9876543210",
            confirmGr: "4501",
            isLocalKiosk: true,
          })
        ).status,
        200,
      );
      assert.equal(
        (await req("/api/admin/dashboard")).data.logs[0].is_guardian,
        1,
      );
      const verify = await fetch(base + "/verify/" + issued.data.serialNo);
      assert.equal(verify.status, 200);
      const html = await verify.text();
      assert.ok(!html.includes("Aarav"));
      assert.equal((await fetch(base + "/verify/MISSING")).status, 404);
      assert.equal(
        (await fetch(base + "/api/documents/" + issued.data.serialNo + "/pdf"))
          .status,
        403,
      );
      if (browserPath()) {
        const r = await fetch(
          base + "/api/documents/" + issued.data.serialNo + "/pdf",
          { headers: { "x-document-token": issued.data.downloadToken } },
        );
        assert.equal(r.status, 200);
        const b = Buffer.from(await r.arrayBuffer());
        assert.equal(b.subarray(0, 4).toString(), "%PDF");
        assert.ok(b.length > 10000);
        const document = await require("pdf-lib").PDFDocument.load(b);
        assert.equal(document.getPageCount(), 1);
        assert.ok(Math.abs(document.getPage(0).getWidth() - 595.28) < 2);
        assert.ok(Math.abs(document.getPage(0).getHeight() - 841.89) < 2);
        if (process.env.KIOSK_QA_DIR) {
          fs.mkdirSync(process.env.KIOSK_QA_DIR, { recursive: true });
          fs.writeFileSync(
            path.join(process.env.KIOSK_QA_DIR, "certificate.pdf"),
            b,
          );
        }
      }
      // Persist a lock, restart, then advance only the test record's lock expiry.
      for (let i = 0; i < 3; i++)
        assert.equal(
          (
            await req("/api/generate-document", "POST", {
              ...payload,
              grNumber: "4505",
              birthYear: "1900",
              isLocalKiosk: true,
            })
          ).status,
          i === 2 ? 423 : 401,
        );
      await stop();
      await start();
      assert.equal(
        (
          await req("/api/generate-document", "POST", {
            ...payload,
            grNumber: "4505",
            birthYear: "2015",
            isLocalKiosk: true,
          })
        ).status,
        423,
      );
      const testDb = new Database(path.join(dir, "school.db"));
      testDb
        .prepare(
          "UPDATE verification_attempts SET locked_until=? WHERE gr_number=?",
        )
        .run(Date.now() - 1, "4505");
      testDb.close();
      assert.equal(
        (
          await req("/api/generate-document", "POST", {
            ...payload,
            grNumber: "4505",
            birthYear: "2015",
            isLocalKiosk: true,
          })
        ).status,
        200,
      );
      await login();
      const student = {
        gr_number: "9900",
        full_name: "<img src=x onerror=alert(1)>",
        father_name: "Test",
        class_name: "8th",
        division: "A",
        dob: "01/01/2013",
        parent_phone: "9876543210",
        aadhaar_last4: "1111",
      };
      assert.equal(
        (await req("/api/admin/students", "POST", student)).status,
        200,
      );
      assert.equal(
        (
          await req("/api/admin/students", "POST", {
            ...student,
            dob: "31/02/2013",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await req("/api/admin/students", "POST", {
            ...student,
            aadhaar_last4: "123456789012",
          })
        ).status,
        400,
      );
      const safe = await req("/api/generate-document", "POST", {
        ...payload,
        grNumber: "9900",
        isLocalKiosk: true,
      });
      assert.equal(safe.status, 200);
      assert.ok(!safe.data.bodyHtml.includes("<img"));
      const csv =
        'gr_number,full_name,father_name,class_name,division,dob,aadhaar_last4,parent_phone\n9911,"Patil, Sai",Mahesh,9th,A,01/01/2012,2222,9876543210';
      assert.equal(
        (await req("/api/admin/students/bulk", "POST", { csv })).data.count,
        1,
      );
      assert.equal(
        (
          await req("/api/admin/students/bulk", "POST", {
            rows: [
              { ...student, gr_number: "new-valid" },
              { ...student, dob: "bad" },
            ],
          })
        ).status,
        400,
      );
      assert.ok(
        !(await req("/api/admin/dashboard")).data.students.some(
          (s) => s.gr_number === "new-valid",
        ),
      );
      assert.equal(
        (await req("/api/admin/students/9900", "DELETE")).status,
        200,
      );
      assert.match(
        await (
          await fetch(base + "/api/admin/sample.csv", {
            headers: { "x-admin-token": token },
          })
        ).text(),
        /aadhaar_last4/,
      );
      const draft = {
        title_mr: "चाचणी",
        title_hi: "परीक्षण",
        title_en: "Test",
        body_html: "<script>alert(1)</script><p>{{student_name}}</p>",
        body_mr: "<p>{{student_name}}</p>",
        body_hi: "<p>{{student_name}}</p>",
        sig_pos: "center",
        stamp_pos: "left",
      };
      const newTpl = (await req("/api/admin/templates", "POST", draft)).data.id;
      assert.ok(newTpl);
      assert.equal(
        (
          await req("/api/admin/templates/" + newTpl, "PUT", {
            ...draft,
            title_en: "Edited",
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await req("/api/admin/template-preview", "POST", {
            ...draft,
            lang: "hi",
          })
        ).status,
        200,
      );
      assert.equal(
        (await req("/api/admin/templates/" + newTpl, "PATCH", { is_active: 0 }))
          .status,
        200,
      );
      assert.ok(
        !(await req("/api/public-config")).data.templates.some(
          (t) => t.id === newTpl,
        ),
      );
      assert.equal(
        (await req("/api/admin/templates/" + newTpl, "DELETE")).status,
        200,
      );
      assert.equal(
        (
          await req("/api/admin/settings", "POST", {
            signature_data: "javascript:alert(1)",
          })
        ).status,
        400,
      );
      const backup = await req("/api/admin/backup", "POST", {});
      assert.equal(backup.status, 200);
      const bdb = new Database(path.join(dir, "backups", backup.data.filename));
      assert.equal(bdb.pragma("integrity_check", { simple: true }), "ok");
      assert.ok(bdb.prepare("SELECT count(*) n FROM issued_logs").get().n > 0);
      bdb.close();
      // Public LAN paths work, while monitor codes and localhost bypass remain protected.
      if (c.lanIp !== "localhost") {
        const remote = `http://${c.lanIp}:${port}`;
        const rr = await fetch(remote + "/api/public-config");
        assert.equal(rr.status, 200);
        assert.equal((await rr.json()).isLocalKiosk, false);
        assert.equal((await fetch(remote + "/api/campus-code")).status, 403);
        assert.equal(
          (
            await fetch(remote + "/api/generate-document", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...payload, isLocalKiosk: true }),
            })
          ).status,
          403,
        );
      }
      assert.equal(
        (
          await fetch(base + "/api/health", {
            headers: { origin: "https://example.com" },
          })
        ).status,
        403,
      );
      assert.equal(
        await new Promise((resolve, reject) => {
          require("node:http")
            .get(
              base + "/api/health",
              { headers: { Host: "evil.example" } },
              (r) => {
                r.resume();
                resolve(r.statusCode);
              },
            )
            .on("error", reject);
        }),
        403,
      );
      assert.equal((await req("/api/unknown")).status, 404);
      assert.equal(
        (
          await fetch(
            base +
              "/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=hello",
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(
            base +
              "/webhook?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=hello",
          )
        ).status,
        403,
      );
      assert.equal((await req("/webhook", "POST", {})).status, 503);
      if (browserPath()) await browserChecks(base);
      assert.equal(
        (
          await req("/api/admin/change-password", "POST", {
            currentPassword: "school1234",
            newPassword: "new-password-123",
          })
        ).status,
        200,
      );
      assert.equal((await req("/api/admin/dashboard")).status, 401);
      await login("new-password-123");
      assert.equal((await req("/api/admin/logout", "POST", {})).status, 200);
      assert.equal((await req("/api/admin/dashboard")).status, 401);
      await stop();
      await start();
      await login("new-password-123");
      assert.equal((await req("/api/admin/dashboard")).data.students.length, 7);
    } finally {
      if (child && child.exitCode === null) await stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
async function browserChecks(base) {
  const browser = await puppeteer.launch({
    executablePath: browserPath(),
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const errors = [];
  const outside = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      if (
        r.url().startsWith(base) ||
        r.url().startsWith("data:") ||
        r.url().startsWith("about:")
      )
        r.continue();
      else {
        outside.push(r.url());
        r.abort();
      }
    });
    await page.goto(base);
    await page.waitForFunction(() => state.config !== null);
    if (process.env.KIOSK_QA_DIR) {
      fs.mkdirSync(process.env.KIOSK_QA_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(process.env.KIOSK_QA_DIR, "welcome.png"),
        fullPage: true,
      });
    }
    await page.click('[data-lang="mr"]');
    await page.waitForSelector("#step-2:not([hidden])");
    await page.type("#parent-phone", "9822011111");
    await page.waitForSelector("#search-results .student");
    assert.match(
      await page.$eval("#search-results", (el) => el.textContent),
      /\*\*\*\*\*\*1111/,
    );
    await page.click("#search-results .student");
    await page.type("#birth-year", "2013");
    await page.click(".document");
    await page.click("#generate-button");
    await page.waitForSelector("#step-4:not([hidden])");
    await page.waitForFunction(
      () =>
        document.getElementById("certificate-frame").contentDocument?.fonts
          .status === "loaded",
    );
    assert.match(
      await page.$eval(
        "#certificate-frame",
        (el) => el.contentDocument.body.textContent,
      ),
      /Aarav/,
    );
    if (process.env.KIOSK_QA_DIR)
      await page.screenshot({
        path: path.join(process.env.KIOSK_QA_DIR, "certificate.png"),
        fullPage: true,
      });
    await page.click("#done-button");
    assert.equal(await page.evaluate(() => state.cert), null);
    assert.equal(await page.$eval("#print-sheet", (e) => e.innerHTML), "");
    assert.equal(
      await page.$eval("#certificate-frame", (e) => e.hasAttribute("srcdoc")),
      false,
    );
    await page.click('[data-lang="en"]');
    await page.click('[data-pad="2"] button');
    assert.equal(await page.$eval("#parent-phone", (e) => e.value), "1");
    await page.evaluate(() => {
      lastActivity = Date.now() - 46000;
    });
    await page.waitForSelector("#step-1:not([hidden])");
    assert.equal(await page.$eval("#parent-phone", (e) => e.value), "");
    await page.click('[data-view="admin"]');
    await page.type("#admin-password", "school1234");
    await page.click("#login-form button");
    await page.waitForSelector("#admin-content:not([hidden])");
    await page.waitForSelector("#students-table tr");
    for (const tab of [
      "templates",
      "branding",
      "logs",
      "security",
      "students",
    ]) {
      await page.click('[data-admin-tab="' + tab + '"]');
      await page.waitForSelector("#admin-" + tab + ":not([hidden])");
    }
    await page.click('[data-admin-tab="templates"]');
    await page.waitForFunction(() =>
      document.getElementById("template-preview").hasAttribute("srcdoc"),
    );
    assert.ok(
      await page.$eval("#template-preview", (el) =>
        el.contentDocument.body.textContent.includes("Aarav"),
      ),
    );
    await page.click('[data-body-lang="mr"]');
    await page.waitForFunction(() =>
      document.getElementById("preview-status").textContent.includes("MR"),
    );
    if (process.env.KIOSK_QA_DIR)
      await page.screenshot({
        path: path.join(process.env.KIOSK_QA_DIR, "admin.png"),
        fullPage: true,
      });
    // Strictly two tabs (Front Panel & Admin) and one single live campus QR
    const navViews = await page.$$eval("[data-view]", (els) =>
      els.map((e) => e.dataset.view),
    );
    assert.deepEqual(navViews, ["parent", "admin"]);
    assert.equal(await page.$("#monitor-view"), null);
    await page.click('[data-view="parent"]');
    await page.waitForFunction(
      () => {
        const img = document.getElementById("qr-live");
        const code = document.getElementById("front-code");
        return (
          img &&
          (img.getAttribute("src") || "").startsWith("data:") &&
          code &&
          /^[0-9]{4}$/.test(code.textContent.trim())
        );
      },
      { timeout: 5000 },
    );
    assert.equal(await page.evaluate(() => state.token), "");
    await page.setViewport({ width: 390, height: 844 });
    await page.click('[data-view="parent"]');
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    assert.deepEqual(outside, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

test("migration preserves existing school records and credentials", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rgc-migrate-"));
  const { openDatabase, hashPassword, checkPassword } = require("../db");
  let d = new Database(path.join(dir, "school.db"));
  d.exec(
    `CREATE TABLE students(gr_number TEXT PRIMARY KEY,full_name TEXT NOT NULL,father_name TEXT,class_name TEXT NOT NULL,division TEXT NOT NULL,dob TEXT NOT NULL,birth_year TEXT NOT NULL,parent_phone TEXT NOT NULL,status TEXT DEFAULT 'ACTIVE');CREATE TABLE admin_users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,password_hash TEXT);`,
  );
  d.prepare("INSERT INTO students VALUES(?,?,?,?,?,?,?,?,?)").run(
    "4501",
    "Existing Real Record",
    "Existing Parent",
    "8th",
    "C",
    "01/01/2013",
    "2013",
    "9876543210",
    "ACTIVE",
  );
  d.prepare("INSERT INTO admin_users VALUES(1,?,?)").run(
    "admin",
    hashPassword("existing-password"),
  );
  d.close();
  try {
    d = openDatabase(dir);
    const row = d
      .prepare("SELECT * FROM students WHERE gr_number=?")
      .get("4501");
    assert.equal(row.full_name, "Existing Real Record");
    assert.equal(row.division, "C");
    assert.equal(row.aadhaar_last4, "");
    assert.ok(
      checkPassword(
        "existing-password",
        d.prepare("SELECT password_hash FROM admin_users").get().password_hash,
      ),
    );
    d.close();
    d = openDatabase(dir);
    assert.equal(d.prepare("SELECT count(*) n FROM students").get().n, 5);
    assert.equal(d.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "campus code rotates automatically after sixty seconds without issuance",
  { timeout: 80000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rgc-timer-"));
    const port = 40000 + Math.floor(Math.random() * 10000);
    const child = spawn(process.execPath, ["server.js"], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        KIOSK_DATA_DIR: dir,
      },
      stdio: "ignore",
    });
    const url = `http://127.0.0.1:${port}/api/campus-code`;
    try {
      let initial;
      for (let i = 0; i < 100; i++) {
        try {
          const r = await fetch(url);
          if (r.ok) {
            initial = await r.json();
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(initial);
      await new Promise((r) => setTimeout(r, 61000));
      const rotated = await (await fetch(url)).json();
      assert.notEqual(rotated.code, initial.code);
      assert.ok(rotated.expiresAt > initial.expiresAt);
      assert.ok(rotated.secondsLeft > 55);
    } finally {
      const ended = new Promise((r) => child.once("exit", r));
      child.kill();
      await ended;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
