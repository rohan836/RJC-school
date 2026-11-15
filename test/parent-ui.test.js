const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const puppeteer = require("puppeteer-core");
const { browserPath } = require("../certificate");
const { openDatabase } = require("../db");

function installFakeFaceCameraScript() {
  return () => {
    window.__RJC_DISABLE_AUTO_PRINT__ = true;
    const ensureDevices = () => {
      if (!navigator.mediaDevices) navigator.mediaDevices = {};
      navigator.mediaDevices.getUserMedia = async () => {
        const c = document.createElement("canvas");
        c.width = 320;
        c.height = 240;
        const ctx = c.getContext("2d");
        const paint = () => {
          ctx.fillStyle = "#ebe8e1";
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.save();
          ctx.beginPath();
          ctx.ellipse(160, 115, 70, 82, 0, 0, Math.PI * 2);
          ctx.fillStyle = "#cf9b7c";
          ctx.fill();
          ctx.fillStyle = "#b88264";
          ctx.fillRect(154, 98, 12, 34);
          // Left and right eyes (white sclera + dark iris)
          for (const ex of [125, 195]) {
            ctx.beginPath();
            ctx.ellipse(ex, 89, 13, 8, 0, 0, Math.PI * 2);
            ctx.fillStyle = "#f7f6f2";
            ctx.fill();
            ctx.beginPath();
            ctx.arc(ex, 89, 5, 0, Math.PI * 2);
            ctx.fillStyle = "#1c1816";
            ctx.fill();
          }
          // Mouth
          ctx.fillStyle = "#9b564f";
          ctx.fillRect(138, 155, 44, 8);
          ctx.restore();
        };
        paint();
        const timer = setInterval(paint, 120);
        const stream = c.captureStream(10);
        const origStop = stream.getTracks()[0]?.stop?.bind(stream.getTracks()[0]);
        if (stream.getTracks()[0]) {
          stream.getTracks()[0].stop = () => {
            clearInterval(timer);
            if (origStop) origStop();
          };
        }
        return stream;
      };
    };
    ensureDevices();
  };
}

test("parent wizard completes search, keypad verify, face proof, student card, and teacher-approval hold on desktop and mobile", { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-parent-ui-"));
  const db = openDatabase(dir);
  db.prepare("DELETE FROM students").run();
  db.prepare(
    "INSERT INTO students(gr_number,full_name,class_name,division,dob,birth_year,parent_phone,aadhaar_last4,status) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run("SYN-1", "Synthetic Student", "1", "A", "01/01/2014", "2014", "9800000001", "1111", "ACTIVE");
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

  let browser;
  try {
    const base = `http://127.0.0.1:${port}`;
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

    browser = await puppeteer.launch({
      executablePath: browserPath(),
      headless: true,
      args: process.platform === "linux" ? ["--no-sandbox"] : [],
    });
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(installFakeFaceCameraScript());

    for (const width of [1440, 390]) {
      await page.setViewport({ width, height: 900 });
      await page.goto(base, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => document.getElementById("front-code").textContent.trim().length === 4);
      // Desktop keeps left QR panel permanently visible; mobile hides .front-qr
      assert.equal(await page.$eval("#front-qr-panel", (el) => getComputedStyle(el).display === "none"), width < 861);

      await page.type("#search-query", "Synthetic");
      await page.waitForSelector("#candidate-results .student");
      await page.click("#candidate-results .student");
      await page.waitForSelector("#step-3:not([hidden])");

      // Use on-screen mouse keypad for MM (01) and YYYY (2014), then type GR
      await page.click('[data-keypad-target="birth-month"]');
      await page.click('.keypad-key[data-key="0"]');
      await page.click('.keypad-key[data-key="1"]');
      await page.click('.keypad-key[data-key="2"]');
      await page.click('.keypad-key[data-key="0"]');
      await page.click('.keypad-key[data-key="1"]');
      await page.click('.keypad-key[data-key="4"]');
      await page.type("#family-identifier", "SYN-1");
      await page.click("#family-button");

      // Face proof gate unlocks capture button once live check passes
      await page.waitForSelector("#step-face:not([hidden])");
      await page.waitForFunction(() => !document.getElementById("face-capture-btn").disabled, { timeout: 10000 });
      await page.click("#face-capture-btn");
      await page.waitForSelector("#face-continue-btn:not([hidden])");
      await page.click("#face-continue-btn");

      await page.waitForSelector("#step-4:not([hidden]) .id-choose-btn");
      await page.click("#step-4 .id-choose-btn");
      await page.waitForSelector("#step-5:not([hidden])");
      assert.equal(await page.$eval("#guardian-option", (el) => el.hidden), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

      await page.click("#document-list button");
      assert.equal(await page.$eval("#campus-code", (el) => el.offsetParent === null), true);
      await page.click("#generate-button");

      await page.waitForSelector("#step-6:not([hidden])");
      assert.match(await page.$eval("#req-id-display", (el) => el.textContent), /^REQUEST #REQ-/);
      await page.click("#done-button");
      await page.waitForSelector("#step-2:not([hidden])");
    }
  } finally {
    if (browser) await browser.close();
    child.kill();
    await new Promise((r) => child.once("exit", r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
