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
    const seed = require('../db').openDatabase(dir);
    seed.prepare('DELETE FROM students').run();
    const addFixture = seed.prepare("INSERT INTO students(gr_number,full_name,father_name,class_name,division,dob,birth_year,parent_phone,aadhaar_last4,status) VALUES(?,?,?,?,?,?,?,?,?,?)");
    for (let i=1; i<=6; i++) addFixture.run('SYN-'+i, 'Synthetic Student '+i, 'Synthetic Parent', String(i), 'A', '01/01/2014', '2014', '980000000'+i, '1111', 'ACTIVE');
    seed.close();
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
    const searchStudentRef = async (query) => {
      const result = await req(
        "/api/search-student",
        "POST",
        { mode: "query", query },
        false,
      );
      assert.equal(result.status, 200);
      assert.ok(result.data.students.length, `Search ${query}`);
      return result.data.students[0].studentRef;
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
      assert.equal((await req('/api/health')).data.journalMode, 'wal');
      assert.equal((await req('/api/search-student', 'POST', {query:'Synthetic'})).status, 401);
      assert.equal((await req('/api/generate-document', 'POST', {isLocalKiosk:true})).status, 401);
      await login();
      const c = (await req('/api/campus-code')).data;
      const config = { templates: (await req('/api/admin/dashboard')).data.templates };
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
        !(await req("/api/admin/dashboard")).data.templates.some(
          (t) => t.id === newTpl && t.is_active,
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
      if (c.lanIp !== 'localhost') {
        const remote = `http://${c.lanIp}:${port}`;
        assert.equal((await fetch(remote + '/api/campus-code')).status, 403);
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
      assert.equal((await req("/webhook", "POST", {})).status, 410);
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
      assert.equal((await req("/api/admin/dashboard")).data.students.length, 9);
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
    await page.click("#new-template");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      await page.$eval("#preview-status", (el) => el.textContent),
      "Enter titles and body to preview.",
    );
    assert.equal(
      await page.$eval("#template-preview", (el) => el.hasAttribute("srcdoc")),
      false,
    );
    for (const [name, value] of [
      ["title_en", "Browser UI draft"],
      ["title_mr", "चाचणी"],
      ["title_hi", "परीक्षण"],
    ])
      await page.$eval(
        `#template-form [name="${name}"]`,
        (el, text) => {
          el.value = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        },
        value,
      );
    await page.type("#template-body", "<p>English draft</p>");
    await page.click('[data-body-lang="mr"]');
    await page.type("#template-body", "<p>Marathi draft</p>");
    await page.click('[data-body-lang="en"]');
    assert.equal(
      await page.$eval("#template-body", (el) => el.value),
      "<p>English draft</p>",
    );
    await page.waitForFunction(() =>
      document.getElementById("preview-status").textContent.includes("EN"),
    );

    await page.click('[data-admin-tab="students"]');
    await page.click("#new-student");
    for (const [name, value] of Object.entries({
      gr_number: "9952",
      full_name: "Browser UI Check",
      father_name: "Local QA",
      class_name: "7th",
      division: "A",
      dob: "01/01/2017",
      aadhaar_last4: "6789",
      parent_phone: "9822099952",
      status: "ACTIVE",
    }))
      await page.$eval(
        `#student-form [name="${name}"]`,
        (el, text) => {
          el.value = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        },
        value,
      );
    await page.click("#student-form button.primary");
    await page.waitForFunction(
      () => document.getElementById("admin-status").textContent === "Student saved.",
    );
    assert.ok(
      await page.evaluate(() =>
        state.admin.students.some((student) => student.gr_number === "9952"),
      ),
    );
    await page.click('[data-edit-student="9952"]');
    assert.equal(
      await page.$eval('#student-form [name="gr_number"]', (el) => el.readOnly),
      true,
    );
    await page.click("#cancel-student");
    assert.equal(
      await page.$eval('#student-form [name="gr_number"]', (el) => el.value),
      "",
    );
    page.once("dialog", (dialog) => dialog.accept());
    await page.click('[data-delete-student="9952"]');
    await page.waitForFunction(
      () =>
        state.admin.students.find((student) => student.gr_number === "9952")
          ?.status === "INACTIVE",
    );

    await page.click('[data-admin-tab="branding"]');
    await page.click('[data-clear-image="logo"]');
    assert.equal(
      await page.$eval("#drop-logo", (el) => el.control.id),
      "image-logo",
    );
    await page.$eval("#drop-logo", (zone) => {
      const encoded =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4O0AAAAASUVORK5CYII=";
      const bytes = Uint8Array.from(atob(encoded), (character) =>
        character.charCodeAt(0),
      );
      const file = new File([bytes], "logo.png", { type: "image/png" });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      zone.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
    });
    await page.waitForFunction(
      () => !document.getElementById("preview-logo").hidden,
    );
    assert.equal(await page.$eval("#image-logo", (el) => el.value), "");
    await page.click('[data-clear-image="logo"]');
    assert.equal(await page.$eval("#preview-logo", (el) => el.hidden), true);

    await page.click('[data-admin-tab="logs"]');
    await page.$eval("#logs-filter", (el) => {
      el.value = "no matching browser record";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.match(
      await page.$eval("#logs-count", (el) => el.textContent),
      /^0 of /,
    );
    await page.click("#refresh-logs");
    await page.waitForFunction(() => state.admin !== null);
    await page.click('[data-admin-tab="security"]');
    await page.click("#backup-button");
    await page.waitForFunction(() =>
      document.getElementById("backup-status").textContent.startsWith("Saved:"),
    );

    for (const width of [390, 320]) {
      await page.setViewport({ width, height: 844 });
      for (const tab of [
        "students",
        "templates",
        "branding",
        "logs",
        "security",
      ]) {
        await page.click('[data-admin-tab="' + tab + '"]');
        await page.waitForSelector("#admin-" + tab + ":not([hidden])");
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          `Admin ${tab} has no horizontal page overflow at ${width}px`,
        );
        if (process.env.KIOSK_QA_DIR && width === 320 && tab === "security")
          await page.screenshot({
            path: path.join(process.env.KIOSK_QA_DIR, "admin-mobile.png"),
            fullPage: true,
          });
      }
    }
    await page.setViewport({ width: 320, height: 844 });
    await page.click("#logout-button");
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Admin sign-in fits a narrow phone viewport",
    );
    await page.type("#admin-password", "school1234");
    await page.click("#login-form button");
    await page.waitForSelector("#admin-content:not([hidden])");
    await page.setViewport({ width: 1440, height: 1000 });
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
    assert.equal(d.prepare("SELECT count(*) n FROM students").get().n, 6);
    assert.equal(d.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("branding migration replaces the placeholder school with the real identity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rgc-brand-"));
  const { openDatabase } = require("../db");
  let d = new Database(path.join(dir, "school.db"));
  d.exec(
    `CREATE TABLE school_settings(id INTEGER PRIMARY KEY CHECK(id=1), school_name TEXT, school_subtitle TEXT, udise_no TEXT, whatsapp_number TEXT, logo_data TEXT, signature_data TEXT, stamp_data TEXT);`,
  );
  d.prepare(
    "INSERT INTO school_settings(id,school_name,school_subtitle,udise_no) VALUES(1,?,?,?)",
  ).run(
    "SHREE VIDYA MANDIR HIGH SCHOOL, NASHIK",
    "Recognized by Govt. of Maharashtra • Marathi & Semi-English Medium",
    "27200104502",
  );
  d.close();
  try {
    d = openDatabase(dir);
    const s = d.prepare("SELECT * FROM school_settings WHERE id=1").get();
    assert.equal(s.school_name, "R. J. CHAWARE CONVENT");
    assert.match(s.school_subtitle, /^Jain Minority Institute •/);
    assert.match(
      s.school_subtitle,
      /Chaware Line, Karanja \(Lad\), Dist\. Washim, Maharashtra 444105$/,
    );
    assert.equal(s.udise_no, "");
    assert.equal(d.pragma("user_version", { simple: true }), 2);
    assert.equal(
      d.prepare("SELECT count(*) n FROM students WHERE gr_number='4506'").get()
        .n,
      1,
    );
    d.close();
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
