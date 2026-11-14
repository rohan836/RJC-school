const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { browserPath } = require("../certificate");

const root = path.resolve(__dirname, "..");
const projectKey = crypto
  .createHash("sha256")
  .update(root.toLowerCase())
  .digest("hex");
const port = Number(process.env.PORT || 3000);
const url = `http://localhost:${port}/`;

function health() {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(Error(`Unrecognized service on port ${port}.`));
        }
      });
    });
    req.setTimeout(2000, () => req.destroy());
    req.on("error", reject);
  });
}

function own(h) {
  return h.appId === "rjc-school-portal" && h.projectKey === projectKey;
}

function openBrowser(targetUrl) {
  const executable = browserPath();
  if (executable) {
    const child = spawn(executable, ["--new-window", targetUrl], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();
    return;
  }
  const cmd =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", targetUrl]]
      : process.platform === "darwin"
        ? ["open", [targetUrl]]
        : ["xdg-open", [targetUrl]];
  const child = spawn(cmd[0], cmd[1], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    console.log("Open in your browser: " + targetUrl);
  });
  child.unref();
}

async function run() {
  let h;
  try {
    h = await health();
  } catch (e) {
    if (!["ECONNREFUSED", "ECONNRESET"].includes(e.code)) throw e;
  }
  if (h && !own(h))
    throw Error(
      `Port ${port} belongs to another folder or an older server. Nothing was started. Close that server first.`,
    );
  if (!h) {
    const output = fs.openSync(path.join(root, "server-output.log"), "a");
    const errors = fs.openSync(path.join(root, "server-error.log"), "a");
    const server = spawn(process.execPath, [path.join(root, "server.js")], {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", output, errors],
    });
    server.unref();
    fs.closeSync(output);
    fs.closeSync(errors);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        h = await health();
        if (own(h)) break;
      } catch {}
    }
    if (!h || !own(h))
      throw Error("RJC did not start. Check server-error.log.");
  }
  console.log("RJC: " + url + " (PID " + h.pid + ")");
  if (!process.argv.includes("--no-browser")) {
    openBrowser(url + "?v=" + Date.now());
  }
}

run().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
