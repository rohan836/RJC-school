(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.RjcDualMonitor = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function resolveScreenMode(loc = {}) {
    const pathname = String(loc.pathname || "/").toLowerCase();
    const hostname = String(loc.hostname || "").toLowerCase();
    const rawSearch = String(loc.search || "");
    const params = new URLSearchParams(rawSearch.startsWith("?") ? rawSearch : `?${rawSearch}`);
    const screenParam = (params.get("screen") || "").toLowerCase();
    const kioskParam = params.get("kiosk");

    if (
      pathname === "/kiosk" ||
      pathname === "/parent-screen" ||
      pathname === "/parent" ||
      hostname.startsWith("parent.") ||
      hostname === "parent" ||
      screenParam === "parent" ||
      screenParam === "kiosk" ||
      kioskParam === "1"
    ) {
      return "parent";
    }

    if (
      pathname === "/staff-host" ||
      pathname === "/staff" ||
      hostname.startsWith("staff.") ||
      hostname === "staff" ||
      screenParam === "admin" ||
      screenParam === "staff" ||
      screenParam === "host"
    ) {
      return "staff-host";
    }

    return "standard";
  }

  function getScreenCapabilities(screenMode, opts = {}) {
    const mode = ["parent", "staff-host", "standard"].includes(screenMode)
      ? screenMode
      : "standard";
    const isMobileHandoff = Boolean(opts.isMobileHandoff || opts.mobileParentOnly);

    if (mode === "parent") {
      return {
        mode: "parent",
        screenMode: "parent",
        label: "Monitor 2 · Parent Counter Display",
        isDedicatedParentScreen: true,
        isDedicatedStaffHost: false,
        showQrPanel: !isMobileHandoff,
        showFrontQr: !isMobileHandoff,
        allowParentFrontPanel: true,
        allowAdminView: false,
        allowDailyQueue: false,
        allowAutoPrintPoller: false,
        persistKeypadHistory: false,
        isolatedParentSession: true,
        autoWipeAfterPrintSeconds: 25,
        autoClearAfterPrintSec: 25,
        idleTimeoutMs: 45000,
      };
    }

    if (mode === "staff-host") {
      return {
        mode: "staff-host",
        screenMode: "staff-host",
        label: "Monitor 1 · Staff Room Admin & Queue Host",
        isDedicatedParentScreen: false,
        isDedicatedStaffHost: true,
        showQrPanel: false,
        showFrontQr: false,
        allowParentFrontPanel: false,
        allowAdminView: true,
        allowDailyQueue: true,
        allowAutoPrintPoller: true,
        persistKeypadHistory: true,
        isolatedParentSession: false,
        autoWipeAfterPrintSeconds: 90,
        autoClearAfterPrintSec: 90,
        idleTimeoutMs: 900000,
      };
    }

    return {
      mode: "standard",
      screenMode: "standard",
      label: "Unified School Portal",
      isDedicatedParentScreen: false,
      isDedicatedStaffHost: false,
      showQrPanel: !isMobileHandoff,
      showFrontQr: !isMobileHandoff,
      allowParentFrontPanel: true,
      allowAdminView: !isMobileHandoff,
      allowDailyQueue: !isMobileHandoff,
      allowAutoPrintPoller: !isMobileHandoff,
      persistKeypadHistory: true,
      isolatedParentSession: true,
      autoWipeAfterPrintSeconds: 90,
      autoClearAfterPrintSec: 90,
      idleTimeoutMs: 60000,
    };
  }

  function canParentViewRequest(sessionState = {}, requestRecord = {}) {
    const activeToken = String(sessionState.parentToken || "").trim();
    const activeReqId = String(sessionState.activeRequestId || "").trim();
    const targetReqId = String(requestRecord.id || requestRecord.requestId || "").trim();
    if (!activeToken || !activeReqId || !targetReqId) {
      return false;
    }
    if (activeReqId !== targetReqId) {
      return false;
    }
    if (
      sessionState.expectedSessionToken &&
      String(sessionState.expectedSessionToken).trim() !== activeToken
    ) {
      return false;
    }
    return true;
  }

  function buildDualMonitorLaunchPlan(options = {}) {
    const port = Number(options.port || 3000);
    const baseUrl = String(options.baseUrl || `http://localhost:${port}`).replace(/\/+$/, "");
    const primaryWidth =
      Number(options.primaryWidth || options.parentMonitorX) > 0
        ? Number(options.primaryWidth || options.parentMonitorX)
        : 1920;
    const primaryHeight = Number(options.primaryHeight) > 0 ? Number(options.primaryHeight) : 1080;
    const secondaryWidth = Number(options.secondaryWidth) > 0 ? Number(options.secondaryWidth) : 1920;
    const secondaryHeight = Number(options.secondaryHeight) > 0 ? Number(options.secondaryHeight) : 1080;
    const profileRoot = String(options.profileRoot || "").replace(/[\\/]+$/, "");
    const staffProfileDir = String(
      options.staffProfileDir ||
        (profileRoot ? `${profileRoot}/staff-host` : "staff-host-profile"),
    );
    const parentProfileDir = String(
      options.parentProfileDir ||
        (profileRoot ? `${profileRoot}/parent-kiosk` : "parent-kiosk-profile"),
    );

    const staffUrl = `${baseUrl}/staff-host`;
    const parentUrl = `${baseUrl}/kiosk`;

    const staffBrowserArgs = [
      "--new-window",
      `--user-data-dir=${staffProfileDir}`,
      "--window-position=0,0",
      `--window-size=${primaryWidth},${primaryHeight}`,
      "--kiosk-printing",
      staffUrl,
    ];
    const parentBrowserArgs = [
      "--new-window",
      `--user-data-dir=${parentProfileDir}`,
      `--window-position=${primaryWidth},0`,
      `--window-size=${secondaryWidth},${secondaryHeight}`,
      `--app=${parentUrl}`,
    ];

    const staffMonitor = {
      role: "staff-host",
      monitorIndex: 1,
      url: staffUrl,
      x: 0,
      y: 0,
      width: primaryWidth,
      height: primaryHeight,
      browserArgs: staffBrowserArgs,
      chromiumArgs: staffBrowserArgs,
    };
    const parentMonitor = {
      role: "parent",
      monitorIndex: 2,
      url: parentUrl,
      x: primaryWidth,
      y: 0,
      width: secondaryWidth,
      height: secondaryHeight,
      browserArgs: parentBrowserArgs,
      chromiumArgs: parentBrowserArgs,
    };

    return {
      staffMonitor,
      parentMonitor,
      staffWindow: staffMonitor,
      parentWindow: parentMonitor,
    };
  }

  return {
    resolveScreenMode,
    getScreenCapabilities,
    canParentViewRequest,
    buildDualMonitorLaunchPlan,
  };
});
