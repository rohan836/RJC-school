const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const puppeteer = require("puppeteer-core");
const { browserPath } = require("../certificate");
test(
  "admin layout fills desktop shell and fits mobile across five tabs",
  { timeout: 120000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-layout-"));
    const port = 51000 + Math.floor(Math.random() * 1000);
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(
      process.execPath,
      [path.resolve(__dirname, "../server.js")],
      {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          PORT: String(port),
          KIOSK_DATA_DIR: dir,
          HOST: "127.0.0.1",
          PUBLIC_PORTAL_URL: "",
          PUBLIC_WEBHOOK_URL: "",
        },
        stdio: "ignore",
      },
    );
    let browser;
    const evidence = process.env.LAYOUT_QA_DIR;
    const measurements = [];
    const verticalFailures = [];
    try {
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(base + "/api/health")).ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      const source = fs.readFileSync(
        path.resolve(__dirname, "../public/index.html"),
        "utf8",
      );
      assert.equal(
        await (await fetch(base)).text(),
        source,
        "isolated server serves current file",
      );
      try {
        const live = await fetch("http://127.0.0.1:3000/");
        const html = await live.text();
        measurements.push({
          liveLocalhost: live.status,
          assetMatches: html === source,
        });
      } catch (e) {
        measurements.push({ liveLocalhost: "unavailable" });
      }
      browser = await puppeteer.launch({
        executablePath: browserPath(),
        headless: true,
      });
      for (const phase of ["before", "after"]) {
        const page = await browser.newPage();
        if (phase === "before") {
          const baseline = source.replace(
            /      \/\* Shared desktop shell[\s\S]*?(?=      @media \(prefers-reduced-motion)/,
            "",
          );
          await page.setRequestInterception(true);
          page.on("request", (r) =>
            r.url() === base + "/"
              ? r.respond({
                  status: 200,
                  contentType: "text/html",
                  body: baseline,
                })
              : r.continue(),
          );
        }
        await page.setViewport({
          width: 1920,
          height: 1080,
          deviceScaleFactor: 1,
        });
        await page.goto(base);
        await page.waitForFunction(() => state.config !== null);
        await page.click('[data-view="admin"]');
        await page.type("#admin-password", "school1234");
        await page.click("#login-form button");
        await page.waitForSelector("#admin-content:not([hidden])");
        const sizes =
          phase === "before"
            ? [[1920, 1080]]
            : [
                [1920, 1080],
                [1366, 768],
                [1440, 900],
                [390, 844],
                [320, 844],
              ];
        for (const [width, height] of sizes) {
          await page.setViewport({ width, height, deviceScaleFactor: 1 });
          for (const tab of [
            "students",
            "templates",
            "branding",
            "logs",
            "security",
          ]) {
            await page.click(`[data-admin-tab="${tab}"]`);
            await page.waitForSelector(`#admin-${tab}:not([hidden])`);
            if (tab === "templates")
              await page.waitForFunction(
                () =>
                  document
                    .querySelector("#template-preview")
                    .hasAttribute("srcdoc") &&
                  !document
                    .querySelector("#preview-status")
                    .textContent.includes("Updating"),
              );
            const m = await page.evaluate(() => {
              const main = document.querySelector("#admin-view"),
                head = document.querySelector(".top-inner");
              const b = main.getBoundingClientRect();
              return {
                viewport: innerWidth, docHeight: document.documentElement.scrollHeight, viewHeight: innerHeight,
                dpr: devicePixelRatio,
                scale: visualViewport.scale,
                shell: b.width,
                left: b.left,
                header: head.getBoundingClientRect().width,
                overflow: document.documentElement.scrollWidth > innerWidth,
                bodyFont: getComputedStyle(document.body).fontSize,
                zoom: getComputedStyle(document.body).zoom,
              };
            });
            measurements.push({ phase, width, height, tab, ...m }); if(phase === "after" && width > 860) console.log(JSON.stringify({width, height, tab, docHeight:m.docHeight}));
            if (phase === "after") {
              if (width > 860) {
                const selector = {students:"#student-form button.primary",templates:"#template-form button.primary",branding:"#branding-form button.primary",logs:"#refresh-logs",security:"#backup-button"}[tab];
                const visible = await page.$eval(selector, el => { const r=el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; });
                assert.ok(visible, `${width} ${tab} primary action visible`);
              }
              assert.equal(m.overflow, false, `${width} ${tab} overflow`);
              assert.equal(m.scale, 1);
              assert.equal(m.zoom, "1");
              if (width > 860) {
                if (m.docHeight > height + 1) verticalFailures.push(`${width} ${tab}: document ${m.docHeight}px > viewport ${height}px`);
                assert.ok(m.shell >= width * 0.9, `${width} shell width`);
                assert.ok(Math.abs(m.header - m.shell) < 1);
              }
            }
            if (evidence) {
              fs.mkdirSync(evidence, { recursive: true });
              await page.screenshot({
                path: path.join(evidence, `${phase}-${width}-${tab}.png`),
                fullPage: true,
              });
            }
          }
        }
        await page.close();
      }
      if (evidence)
        fs.writeFileSync(
          path.join(evidence, "measurements.json"),
          JSON.stringify(measurements, null, 2),
        );
      assert.deepEqual(verticalFailures, [], "desktop tabs must fit vertically");
      console.log(
        JSON.stringify(
          measurements.filter((x) => x.tab === "students" || x.liveLocalhost),
          null,
          2,
        ),
      );
    } finally {
      if (browser) await browser.close();
      child.kill();
      await new Promise((r) =>
        child.exitCode !== null ? r() : child.once("exit", r),
      );
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
