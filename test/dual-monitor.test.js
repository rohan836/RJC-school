const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveScreenMode,
  getScreenCapabilities,
  canParentViewRequest,
  buildDualMonitorLaunchPlan,
} = require("../public/dual-monitor");

test("resolveScreenMode routes /kiosk, /parent-screen, and ?screen=parent to isolated parent display", () => {
  assert.equal(resolveScreenMode({ pathname: "/kiosk", search: "" }), "parent");
  assert.equal(resolveScreenMode({ pathname: "/parent-screen", search: "" }), "parent");
  assert.equal(resolveScreenMode({ pathname: "/", search: "?screen=parent" }), "parent");
  assert.equal(resolveScreenMode({ pathname: "/", search: "?kiosk=1" }), "parent");

  assert.equal(resolveScreenMode({ pathname: "/staff-host", search: "" }), "staff-host");
  assert.equal(resolveScreenMode({ pathname: "/", search: "?screen=admin" }), "staff-host");
  assert.equal(resolveScreenMode({ pathname: "/admin", search: "?screen=staff" }), "staff-host");

  assert.equal(resolveScreenMode({ pathname: "/", search: "" }), "standard");
  assert.equal(resolveScreenMode({ pathname: "/admin", search: "" }), "standard");
});

test("getScreenCapabilities enforces strict isolation between Staff Room Monitor 1 and Parent Counter Monitor 2", () => {
  const parentCaps = getScreenCapabilities("parent");
  assert.equal(parentCaps.mode, "parent");
  assert.equal(parentCaps.showQrPanel, true);
  assert.equal(parentCaps.allowAdminView, false);
  assert.equal(parentCaps.allowDailyQueue, false);
  assert.equal(parentCaps.allowAutoPrintPoller, false);
  assert.equal(parentCaps.persistKeypadHistory, false);
  assert.equal(parentCaps.isolatedParentSession, true);

  const staffCaps = getScreenCapabilities("staff-host");
  assert.equal(staffCaps.mode, "staff-host");
  assert.equal(staffCaps.showQrPanel, false);
  assert.equal(staffCaps.allowAdminView, true);
  assert.equal(staffCaps.allowDailyQueue, true);
  assert.equal(staffCaps.allowAutoPrintPoller, true);
  assert.equal(staffCaps.persistKeypadHistory, true);
});

test("canParentViewRequest prevents any parent from viewing another parent's application", () => {
  const parentASession = {
    parentToken: "sess-parent-A",
    activeRequestId: "REQ-20261115-1001",
    expectedSessionToken: "sess-parent-A",
  };

  // Parent A can see their own request
  assert.equal(
    canParentViewRequest(parentASession, { id: "REQ-20261115-1001" }),
    true,
  );

  // Parent A cannot see Parent B's request
  assert.equal(
    canParentViewRequest(parentASession, { id: "REQ-20261115-2002" }),
    false,
  );

  // Wiped / unauthenticated session cannot see any request
  assert.equal(
    canParentViewRequest({ parentToken: "", activeRequestId: "" }, { id: "REQ-20261115-1001" }),
    false,
  );

  // Mismatched session token cannot see the request even if requestId matches
  assert.equal(
    canParentViewRequest(
      {
        parentToken: "sess-parent-B",
        activeRequestId: "REQ-20261115-1001",
        expectedSessionToken: "sess-parent-A",
      },
      { id: "REQ-20261115-1001" },
    ),
    false,
  );
});

test("buildDualMonitorLaunchPlan configures isolated profiles and window positions for Monitor 1 (0,0) and Monitor 2 (1920,0)", () => {
  const plan = buildDualMonitorLaunchPlan({
    baseUrl: "http://localhost:3000",
    primaryWidth: 1920,
    primaryHeight: 1080,
    secondaryWidth: 1920,
    secondaryHeight: 1080,
    staffProfileDir: "C:\\RJC\\profiles\\staff",
    parentProfileDir: "C:\\RJC\\profiles\\parent",
  });

  assert.equal(plan.staffMonitor.url, "http://localhost:3000/staff-host");
  assert.equal(plan.staffMonitor.x, 0);
  assert.equal(plan.staffMonitor.y, 0);
  assert.ok(plan.staffMonitor.browserArgs.includes("--window-position=0,0"));
  assert.ok(plan.staffMonitor.browserArgs.includes("--kiosk-printing"));
  assert.ok(plan.staffMonitor.browserArgs.includes("--user-data-dir=C:\\RJC\\profiles\\staff"));

  assert.equal(plan.parentMonitor.url, "http://localhost:3000/kiosk");
  assert.equal(plan.parentMonitor.x, 1920);
  assert.equal(plan.parentMonitor.y, 0);
  assert.ok(plan.parentMonitor.browserArgs.includes("--window-position=1920,0"));
  assert.ok(plan.parentMonitor.browserArgs.includes("--app=http://localhost:3000/kiosk"));
  assert.ok(plan.parentMonitor.browserArgs.includes("--user-data-dir=C:\\RJC\\profiles\\parent"));
});

test(
  "end-to-end dual-monitor isolation, per-parent privacy lock, and 1440x900 geometry alignment",
  { timeout: 120000 },
  async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { spawn } = require("node:child_process");
    const puppeteer = require("puppeteer-core");
    const { browserPath } = require("../certificate");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-dual-mon-"));
    const port = 52300 + Math.floor(Math.random() * 600);
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

    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    let browser;
    try {
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(base + "/api/health")).ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }

      browser = await puppeteer.launch({
        executablePath: browserPath(),
        headless: true,
        args: process.platform === "linux" ? ["--no-sandbox"] : [],
      });

      // Monitor 1: Staff Room Host (/staff-host)
      const staffPage = await browser.newPage();
      await staffPage.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await staffPage.evaluateOnNewDocument(() => {
        window.__RJC_DISABLE_AUTO_PRINT__ = true;
      });
      await staffPage.goto(base + "/staff-host", { waitUntil: "networkidle0" });
      await staffPage.waitForFunction(() => state.config !== null);

      const staffInitial = await staffPage.evaluate(() => {
        const adminView = document.getElementById("admin-view");
        const parentView = document.getElementById("parent-view");
        const parentNavBtn = document.querySelector('[data-view="parent"]');
        const badge = document.getElementById("staff-host-badge");
        const openKioskBtn = document.getElementById("open-parent-kiosk-btn");
        return {
          view: state.view,
          screenMode: state.screenMode,
          hasStaffHostClass: document.body.classList.contains("staff-host-screen"),
          adminVisible: !adminView.hidden,
          parentHidden: parentView.hidden,
          parentNavBtnDisplay: getComputedStyle(parentNavBtn).display,
          badgeVisible: !badge.hidden,
          openKioskBtnVisible: !openKioskBtn.hidden,
        };
      });
      assert.equal(staffInitial.view, "admin");
      assert.equal(staffInitial.screenMode, "staff-host");
      assert.equal(staffInitial.hasStaffHostClass, true);
      assert.equal(staffInitial.adminVisible, true);
      assert.equal(staffInitial.parentHidden, true);
      assert.equal(staffInitial.parentNavBtnDisplay, "none");
      assert.equal(staffInitial.badgeVisible, true);
      assert.equal(staffInitial.openKioskBtnVisible, true);

      // Sign in as Admin on Monitor 1 (/staff-host) and verify geometry alignment
      await staffPage.type("#admin-password", "school1234");
      await staffPage.click("#login-form button");
      await staffPage.waitForSelector("#admin-content:not([hidden])");

      const staffGeo = await staffPage.evaluate(() => {
        const head = document.querySelector(".top-inner").getBoundingClientRect();
        const main = document.getElementById("admin-view").getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          docHeight: document.documentElement.scrollHeight,
          viewHeight: innerHeight,
          headWidth: head.width,
          mainWidth: main.width,
          leftDiff: Math.abs(head.left - main.left),
        };
      });
      assert.equal(staffGeo.overflow, false, "Monitor 1 /staff-host must have zero horizontal overflow");
      assert.ok(staffGeo.docHeight <= staffGeo.viewHeight + 1, "Monitor 1 /staff-host fits 1440x900 height");
      assert.ok(Math.abs(staffGeo.headWidth - staffGeo.mainWidth) < 1, "Monitor 1 header and main widths align");
      assert.ok(staffGeo.leftDiff < 1, "Monitor 1 header and main left edges align");

      // Monitor 2: Parent Counter Screen (/kiosk)
      const parentPage = await browser.newPage();
      await parentPage.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await parentPage.goto(base + "/kiosk", { waitUntil: "networkidle0" });
      await parentPage.waitForFunction(() => state.config !== null);
      await parentPage.waitForFunction(
        () => Boolean(document.querySelector("#qr-live")?.getAttribute("src")),
      );

      const parentIsolation = await parentPage.evaluate(() => {
        // Attempt to open Admin or Daily Queue programmatically on Monitor 2
        switchView("admin");
        openCounterDesk();
        const head = document.querySelector(".top-inner").getBoundingClientRect();
        const main = document.getElementById("parent-view").getBoundingClientRect();
        const qrRect = document.getElementById("front-qr-panel").getBoundingClientRect();
        const wizRect = document.querySelector(".parent-wizard").getBoundingClientRect();
        return {
          view: state.view,
          screenMode: state.screenMode,
          hasKioskClass: document.body.classList.contains("parent-kiosk-screen"),
          navHidden: getComputedStyle(document.querySelector(".nav")).display === "none",
          deskBtnHidden: getComputedStyle(document.getElementById("front-desk-btn")).display === "none",
          qrDeskBtnHidden: getComputedStyle(document.getElementById("front-desk-qr-btn")).display === "none",
          mobileDeskBtnHidden: getComputedStyle(document.getElementById("front-desk-mobile-btn")).display === "none",
          adminViewHidden: getComputedStyle(document.getElementById("admin-view")).display === "none",
          counterDeskHidden: getComputedStyle(document.getElementById("counter-desk-backdrop")).display === "none",
          historyBoxHidden: getComputedStyle(document.querySelector(".history-box")).display === "none",
          parentBarVisible: !document.getElementById("parent-screen-bar").hidden,
          qrVisible: qrRect.width > 200 && qrRect.height > 200,
          wizVisible: wizRect.width > 400 && wizRect.height > 200,
          overflow: document.documentElement.scrollWidth > innerWidth,
          headMainWidthDiff: Math.abs(head.width - main.width),
          headMainLeftDiff: Math.abs(head.left - main.left),
        };
      });

      assert.equal(parentIsolation.view, "parent", "Monitor 2 cannot switch to admin view");
      assert.equal(parentIsolation.screenMode, "parent");
      assert.equal(parentIsolation.hasKioskClass, true);
      assert.equal(parentIsolation.navHidden, true, "Monitor 2 hides top navigation");
      assert.equal(parentIsolation.deskBtnHidden, true, "Monitor 2 hides Daily Queue button");
      assert.equal(parentIsolation.qrDeskBtnHidden, true, "Monitor 2 hides QR Daily Queue button");
      assert.equal(parentIsolation.mobileDeskBtnHidden, true, "Monitor 2 hides mobile Daily Queue button");
      assert.equal(parentIsolation.adminViewHidden, true, "Monitor 2 hides Admin view");
      assert.equal(parentIsolation.counterDeskHidden, true, "Monitor 2 blocks Daily Queue modal");
      assert.equal(parentIsolation.historyBoxHidden, true, "Monitor 2 hides Recent entries history box");
      assert.equal(parentIsolation.parentBarVisible, true, "Monitor 2 shows Private Session header bar");
      assert.equal(parentIsolation.qrVisible, true, "Monitor 2 displays Phone QR code panel");
      assert.equal(parentIsolation.wizVisible, true, "Monitor 2 displays Parent Front Panel wizard");
      assert.equal(parentIsolation.overflow, false, "Monitor 2 has zero horizontal overflow");
      assert.ok(parentIsolation.headMainWidthDiff < 1, "Monitor 2 header and workspace widths align");
      assert.ok(parentIsolation.headMainLeftDiff < 1, "Monitor 2 header and workspace left edges align");

      // Parent A submits an application on Monitor 2 (/kiosk)
      const parentAReq = await parentPage.evaluate(async (photoData) => {
        const findRes = await json("/api/parent/find", {
          method: "POST",
          body: { query: "Aarav" },
        });
        const cand = findRes.students[0];
        const startRes = await json("/api/parent/start", {
          method: "POST",
          body: { studentRef: cand.studentRef, lang: "en" },
        });
        state.challenge = startRes.challengeId;
        const famRes = await json("/api/parent/family", {
          method: "POST",
          body: {
            challengeId: state.challenge,
            birthMonth: "06",
            birthYear: "2013",
            grNumber: "4501",
          },
        });
        await acceptVerification(famRes, {
          birthMonth: "06",
          birthYear: "2013",
          grNumber: "4501",
        });
        state.facePhotoData = photoData;
        await confirmFaceProofAndLoadStudents();
        chooseStudent(state.verifiedStudents[0]);
        state.templateId = state.config.templates[0].id;
        await generate();
        return {
          step: state.step,
          requestId: state.activeRequestId,
          parentToken: state.parentToken,
          reqIdText: document.getElementById("req-id-display").textContent,
          studentText: document.getElementById("req-student-display").textContent,
          printText: document.getElementById("req-print-display").textContent,
          savedHistory: window.RjcKeypadHistory.loadHistory(window.localStorage),
        };
      }, tinyPng);

      assert.equal(String(parentAReq.step), "6");
      assert.ok(parentAReq.requestId.startsWith("REQ-"));
      assert.equal(parentAReq.reqIdText, `REQUEST #${parentAReq.requestId}`);
      assert.match(parentAReq.studentText, /Aarav Sunil Patil/);
      assert.equal(parentAReq.printText, "Waiting for teacher approval");
      assert.deepEqual(
        parentAReq.savedHistory,
        { months: [], years: [], grNumbers: [] },
        "Monitor 2 never saves Parent A's GR or birth date to localStorage",
      );

      // Verify another parent (Parent B) cannot read Parent A's request via API
      const findB = await (
        await fetch(base + "/api/parent/find", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "Ananya" }),
        })
      ).json();
      const startB = await (
        await fetch(base + "/api/parent/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ studentRef: findB.students[0].studentRef, lang: "en" }),
        })
      ).json();
      const famB = await (
        await fetch(base + "/api/parent/family", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            challengeId: startB.challengeId,
            birthMonth: "09",
            birthYear: "2011",
            grNumber: "4502",
          }),
        })
      ).json();
      const snoopingRes = await fetch(
        base + "/api/parent/request-status/" + encodeURIComponent(parentAReq.requestId),
        {
          headers: { "x-parent-session": famB.sessionToken },
        },
      );
      assert.equal(
        snoopingRes.status,
        403,
        "Parent B's session token is strictly forbidden from reading Parent A's application status",
      );

      // Staff Room Monitor 1 approves Parent A's request from Daily Queue & triggers print
      await staffPage.click("#front-desk-btn");
      await staffPage.waitForSelector("#counter-desk-backdrop:not([hidden])");
      await staffPage.waitForSelector(`[data-desk-approve="${parentAReq.requestId}"]`);
      await staffPage.click(`[data-desk-approve="${parentAReq.requestId}"]`);

      // Wait for Monitor 1's auto-print poller and Parent A's Monitor 2 status poller to update
      await parentPage.waitForFunction(
        () =>
          document
            .getElementById("req-print-display")
            ?.textContent.includes("Printed (ORIGINAL"),
        { timeout: 15000 },
      );

      const parentAApprovedUi = await parentPage.evaluate(() => ({
        title: document.getElementById("req-status-title").textContent,
        serial: document.getElementById("req-serial-display").textContent,
        print: document.getElementById("req-print-display").textContent,
        pipePrint: document.getElementById("pipe-print").textContent,
      }));
      assert.match(parentAApprovedUi.title, /Approved by School Office Admin/);
      assert.match(parentAApprovedUi.serial, /^RJC-\d{4}-\d{5}$/);
      assert.match(
        parentAApprovedUi.print,
        /Printed \(ORIGINAL · Page 1 of 1 \(Sheet #01\) · 2FA PRT-01-/,
      );
      assert.equal(parentAApprovedUi.pipePrint, "✓ 3. Printed at Counter");

      // Parent A clicks "Clear / New Parent" (#parent-new-session-btn) -> screen resets for Parent B
      await parentPage.click("#parent-new-session-btn");
      const afterReset = await parentPage.evaluate(() => ({
        step: state.step,
        parentToken: state.parentToken,
        activeRequestId: state.activeRequestId,
        step6Hidden: document.getElementById("step-6").hidden,
        step2Visible: !document.getElementById("step-2").hidden,
      }));
      assert.equal(String(afterReset.step), "2");
      assert.equal(afterReset.parentToken, "");
      assert.equal(afterReset.activeRequestId, "");
      assert.equal(afterReset.step6Hidden, true);
      assert.equal(afterReset.step2Visible, true);

      // Even Parent A's old token is now invalidated on the server after reset
      const oldTokenRes = await fetch(
        base + "/api/parent/request-status/" + encodeURIComponent(parentAReq.requestId),
        {
          headers: { "x-parent-session": parentAReq.parentToken },
        },
      );
      assert.equal(oldTokenRes.status, 401, "Cleared parent session token is invalidated on server");
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
