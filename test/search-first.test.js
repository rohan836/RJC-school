const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { openDatabase } = require("../db");
const puppeteer = require("puppeteer-core");
const { browserPath } = require("../certificate");

test("search-first UI shows clean front search with always-on left QR and protects contact/GR identifiers", { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-search-first-"));
  const db = openDatabase(dir);
  db.prepare(
    "INSERT INTO students(gr_number,full_name,father_name,class_name,division,dob,birth_year,parent_phone,aadhaar_last4,status) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run("SYN-900", "Marigold Example", "Synthetic Parent", "3rd", "C", "01/01/2014", "2014", "9800000001", "1111", "ACTIVE");
  db.close();

  const port = 52000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", KIOSK_DATA_DIR: dir, WHATSAPP_TOKEN: "", PUBLIC_PORTAL_URL: "", PUBLIC_WEBHOOK_URL: "" },
    stdio: "ignore",
  });

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

    const found = await (
      await fetch(base + "/api/parent/find", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "ar" }),
      })
    ).json();
    assert.ok(found.students.length);
    assert.ok(found.students.some((s) => s.label === "Marigold Example"));
    assert.ok(!JSON.stringify(found).includes("9800000001"));
    assert.ok(!JSON.stringify(found).includes("SYN-900"));

    browser = await puppeteer.launch({
      executablePath: browserPath(),
      headless: true,
      args: process.platform === "linux" ? ["--no-sandbox"] : [],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.evaluateOnNewDocument(() => {
      window.__RJC_DISABLE_AUTO_PRINT__ = true;
      if (!navigator.mediaDevices) navigator.mediaDevices = {};
      navigator.mediaDevices.getUserMedia = async () => {
        const c = document.createElement("canvas");
        c.width = 320; c.height = 240;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#ebe8e1"; ctx.fillRect(0, 0, 320, 240);
        ctx.beginPath(); ctx.ellipse(160, 115, 70, 82, 0, 0, Math.PI * 2);
        ctx.fillStyle = "#cf9b7c"; ctx.fill();
        for (const ex of [125, 195]) {
          ctx.beginPath(); ctx.ellipse(ex, 89, 13, 8, 0, 0, Math.PI * 2); ctx.fillStyle = "#f7f6f2"; ctx.fill();
          ctx.beginPath(); ctx.arc(ex, 89, 5, 0, Math.PI * 2); ctx.fillStyle = "#1c1816"; ctx.fill();
        }
        ctx.fillStyle = "#9b564f"; ctx.fillRect(138, 155, 44, 8);
        return c.captureStream(5);
      };
    });

    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(base);
    await page.waitForFunction(() => state.config !== null);
    await page.waitForSelector("#step-2:not([hidden])");
    assert.equal(await page.$eval("#front-qr-panel", (el) => el.hidden), false);
    assert.equal(await page.$("#parent-phone"), null);

    // Search bar geometry must not jump horizontally/top-edge when results render
    const boxBefore = await page.$eval("#search-query", (el) => {
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width) };
    });
    await page.type("#search-query", "Marigld");
    await page.waitForSelector("#candidate-results button");
    const boxAfter = await page.$eval("#search-query", (el) => {
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width) };
    });
    assert.deepEqual(boxAfter, boxBefore);

    await page.click("#candidate-results button");
    await page.waitForSelector("#step-3:not([hidden])");
    // Left QR stays visible when right panel advances to step 3
    assert.equal(await page.$eval("#front-qr-panel", (el) => el.hidden), false);

    await page.type("#birth-month", "01");
    await page.type("#birth-year", "2014");
    await page.type("#family-identifier", "SYN-900");
    await page.click("#family-button");

    await page.waitForSelector("#step-face:not([hidden])");
    await page.waitForFunction(() => !document.getElementById("face-capture-btn").disabled, { timeout: 10000 });
    await page.click("#face-capture-btn");
    await page.waitForSelector("#face-continue-btn:not([hidden])");
    await page.click("#face-continue-btn");

    await page.waitForSelector("#step-4:not([hidden])");
    assert.match(await page.$eval("#search-results", (el) => el.textContent), /Marigold Example/);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    const ended = new Promise((r) => child.once("exit", r));
    child.kill();
    await ended;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
