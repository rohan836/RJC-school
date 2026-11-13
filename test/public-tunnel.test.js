const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test(
  "public portal host cannot reach admin or use the localhost campus bypass",
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-public-"));
    const port = 30000 + Math.floor(Math.random() * 20000);
    const base = `http://127.0.0.1:${port}`;
    const publicHost = "portal.example.test";
    const env = { ...process.env };
    for (const name of [
      "PUBLIC_WEBHOOK_URL",
      "WHATSAPP_TOKEN",
      "PHONE_NUMBER_ID",
      "WHATSAPP_APP_SECRET",
      "WHATSAPP_VERIFY_TOKEN",
    ])
      delete env[name];
    const child = spawn(
      process.execPath,
      [path.resolve(__dirname, "..", "server.js")],
      {
        cwd: dir,
        env: {
          ...env,
          PORT: String(port),
          HOST: "127.0.0.1",
          KIOSK_DATA_DIR: dir,
          PUBLIC_PORTAL_URL: `https://${publicHost}`,
        },
        stdio: "ignore",
      },
    );

    const request = (url, method = "GET", body) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: url,
            method,
            headers: {
              Host: publicHost,
              "Content-Type": "application/json",
            },
          },
          (res) => {
            let responseBody = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (responseBody += chunk));
            res.on("end", () =>
              resolve({
                status: res.statusCode,
                json: () => JSON.parse(responseBody),
              }),
            );
          },
        );
        req.on("error", reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
      });

    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(base + "/api/health")).ok) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(ready, "isolated test server starts");

      const configResponse = await request("/api/public-config");
      assert.equal(configResponse.status, 200);
      const config = configResponse.json();
      assert.equal(config.isLocalKiosk, undefined);
      assert.equal(config.templates, undefined);
      assert.equal(config.portalUrl, `https://${publicHost}`);
      assert.equal((await request("/api/campus-code")).status, 403);
      assert.equal((await request("/admin")).status, 403);
      assert.equal((await request("/api/admin/dashboard")).status, 403);
      assert.equal((await request("/verify/MISSING")).status, 404);

      const searchResponse = await request("/api/search-student", "POST", {
        mode: "query",
        query: "8th",
      });
      assert.equal(searchResponse.status, 401);

      const generateResponse = await request(
        "/api/generate-document",
        "POST",
        {
          studentRef: 'unverified',
          templateId: 1,
          isLocalKiosk: true,
        },
      );
      assert.equal(generateResponse.status, 401);

    const localConfig = await (
      await fetch(base + "/api/public-config")
    ).json();
      assert.equal(localConfig.isLocalKiosk, undefined);
      const localCode = await fetch(base + "/api/campus-code");
      assert.equal(localCode.status, 200);
    } finally {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill();
        await exited;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
