#!/usr/bin/env node
"use strict";

const http = require("node:http");
const https = require("node:https");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const dataDir = process.env.KIOSK_DATA_DIR || path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 3000);

async function quickFetch(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const isHttps = url.startsWith("https://");
    const mod = isHttps ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(body); } catch {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, body, json });
      });
    });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "Timed out" });
    });
  });
}

function checkCloudflare() {
  let proc = false;
  let svc = "NOT_INSTALLED";
  try {
    const out = execSync("tasklist /FI \"IMAGENAME eq cloudflared.exe\" /FO CSV /NH", {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    proc = out.toLowerCase().includes("cloudflared.exe");
  } catch {}

  try {
    const sc = execSync("sc.exe query cloudflared", {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (sc.includes("STATE") && sc.includes("RUNNING")) svc = "RUNNING";
    else if (sc.includes("STATE")) svc = "STOPPED";
  } catch {}

  return { proc, svc, active: proc || svc === "RUNNING" };
}

async function main() {
  console.log("===============================================================");
  console.log("          RJC SCHOOL -- SYSTEM & NETWORK STATUS CHECK          ");
  console.log("===============================================================\n");

  // 1. Local Server Check
  const localRes = await quickFetch(`http://127.0.0.1:${port}/api/health`, 2000);
  if (localRes.ok) {
    console.log(`[PASS] Local Server: ONLINE (Listening on port ${port})`);
  } else {
    console.log(`[FAIL] Local Server: OFFLINE (Port ${port} is not responding)`);
    console.log(`       Start the server with: Start_RJC.bat\n`);
  }

  // 2. Public Config
  let publicPortal = "";
  let publicVerify = "";
  if (localRes.ok) {
    const cfg = await quickFetch(`http://127.0.0.1:${port}/api/public-config`, 2000);
    if (cfg.ok && cfg.json) {
      publicPortal = cfg.json.portalUrl || "";
      console.log(`[INFO] School Name:     ${cfg.json.schoolName || "R. J. CHAWARE CONVENT"}`);
      console.log(`[INFO] Configured Base: ${publicPortal}`);
    }
  }

  // Read .env if available
  try {
    const envFile = fs.readFileSync(path.join(dataDir, ".env"), "utf8");
    const mPortal = envFile.match(/^PUBLIC_PORTAL_URL=(.*)$/m);
    const mVerify = envFile.match(/^PUBLIC_VERIFY_URL=(.*)$/m);
    if (mPortal) publicPortal = mPortal[1].trim();
    if (mVerify) publicVerify = mVerify[1].trim();
  } catch {}

  console.log(`[INFO] Primary Portal:  ${publicPortal || "http://localhost:" + port}`);
  if (publicVerify) {
    console.log(`[INFO] Verify Portal:   ${publicVerify}`);
  }

  // 3. Cloudflare Tunnel Check
  const cf = checkCloudflare();
  if (cf.svc === "RUNNING") {
    console.log("[PASS] Cloudflare Tunnel: SERVICE RUNNING (Auto-starts on Windows boot)");
  } else if (cf.proc) {
    console.log("[PASS] Cloudflare Tunnel: PROCESS RUNNING (Standalone instance active)");
  } else {
    console.log("[WARN] Cloudflare Tunnel: NOT RUNNING");
    console.log("       Run tools\\setup-cloudflare-tunnel.bat or tools\\Start_Public_Tunnel.bat");
  }

  // 4. Internet Connectivity
  const netRes = await quickFetch("https://1.1.1.1", 2500);
  if (netRes.ok) {
    console.log("[PASS] Internet Access: ONLINE (DNS & Cloudflare reachable)");
  } else {
    console.log("[WARN] Internet Access: OFFLINE or restricted");
    console.log("       (School counter kiosks and local LAN remain fully functional)");
  }

  // 5. Public URL reachability
  if (publicPortal && publicPortal.startsWith("https://")) {
    const probe = await quickFetch(`${publicPortal}/api/public-config`, 4000);
    if (probe.ok) {
      console.log(`[PASS] Global Parent Portal: REACHABLE (${publicPortal})`);
    } else {
      console.log(`[WARN] Global Parent Portal: UNREACHABLE (${probe.error || probe.status})`);
    }
  }

  if (publicVerify && publicVerify.startsWith("https://")) {
    const probeV = await quickFetch(`${publicVerify}/favicon.ico`, 4000);
    if (probeV.ok) {
      console.log(`[PASS] Global Verify Portal: REACHABLE (${publicVerify})`);
    } else {
      console.log(`[WARN] Global Verify Portal: UNREACHABLE (${probeV.error || probeV.status})`);
    }
  }

  console.log("\n===============================================================");
}

main().catch((e) => console.error(e));
