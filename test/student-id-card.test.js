const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { PNG } = require("pngjs");
const { openDatabase, hashPassword } = require("../db");

function tinyPngDataUrl() {
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 20;
    png.data[i + 1] = 20;
    png.data[i + 2] = 20;
    png.data[i + 3] = 255;
  }
  return "data:image/png;base64," + PNG.sync.write(png).toString("base64");
}

test(
  "admin saves student ID card fields & photo and verified parent sees only non-sensitive student record",
  { timeout: 30000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-id-card-"));
    const db = openDatabase(dir);
    const adminPassword = "synthetic-id-card-password";
    db.prepare("UPDATE admin_users SET password_hash=? WHERE username='admin'").run(
      hashPassword(adminPassword),
    );
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
    const base = `http://127.0.0.1:${port}`;
    const req = async (url, body, headers = {}) => {
      const r = await fetch(base + url, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, data: await r.json().catch(() => null) };
    };

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

      const login = await req("/api/admin/login", {
        username: "admin",
        password: adminPassword,
      });
      assert.equal(login.status, 200);
      const adminHeaders = { "x-admin-token": login.data.token };

      const badPhoto = await req(
        "/api/admin/students",
        {
          gr_number: "9001",
          full_name: "Test Student",
          class_name: "8th",
          division: "A",
          dob: "14/06/2013",
          parent_phone: "9800000011",
          photo_data: "data:image/png;base64,bm90LXBuZw==",
        },
        adminHeaders,
      );
      assert.equal(badPhoto.status, 400);

      const badEmergency = await req(
        "/api/admin/students",
        {
          gr_number: "9001",
          full_name: "Test Student",
          class_name: "8th",
          division: "A",
          dob: "14/06/2013",
          parent_phone: "9800000011",
          emergency_phone: "123",
        },
        adminHeaders,
      );
      assert.equal(badEmergency.status, 400);

      const photo = tinyPngDataUrl();
      const saved = await req(
        "/api/admin/students",
        {
          gr_number: "9001",
          full_name: "Meera Rajesh Kulkarni",
          father_name: "Rajesh Kulkarni",
          mother_name: "Sunita Kulkarni",
          class_name: "8th",
          division: "A",
          dob: "14/06/2013",
          aadhaar_last4: "4321",
          parent_phone: "9800000011",
          roll_no: "12",
          academic_year: "2026-27",
          blood_group: "O+",
          house: "Blue",
          apaar_id: "APAAR-8899",
          emergency_phone: "9800000099",
          bus_route: "Route 3",
          address: "Chaware Line, Karanja (Lad)",
          remarks: "House Captain",
          photo_data: photo,
        },
        adminHeaders,
      );
      assert.equal(saved.status, 200);

      // Updating without photo_data preserves photo
      const updated = await req(
        "/api/admin/students",
        {
          gr_number: "9001",
          full_name: "Meera Rajesh Kulkarni",
          class_name: "8th",
          division: "A",
          dob: "14/06/2013",
          parent_phone: "9800000011",
          blood_group: "B+",
        },
        adminHeaders,
      );
      assert.equal(updated.status, 200);

      const start = await req("/api/parent/start", { phone: "9800000011" });
      const verified = await req("/api/parent/family", {
        challengeId: start.data.challengeId,
        birthYear: "2013",
        identifierType: "gr",
        identifier: "9001",
      });
      assert.equal(verified.status, 200);

      const res = await req("/api/parent/students", undefined, {
        "x-parent-session": verified.data.sessionToken,
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.students.length, 1);
      const s = res.data.students[0];
      assert.equal(s.full_name, "Meera Rajesh Kulkarni");
      assert.equal(s.blood_group, "B+");
      assert.equal(s.photo_data, photo);
      assert.equal(s.aadhaar_last4, undefined);

      // Clearing photo explicitly sets photo_data to ""
      const cleared = await req(
        "/api/admin/students",
        {
          gr_number: "9001",
          full_name: "Meera Rajesh Kulkarni",
          class_name: "8th",
          division: "A",
          dob: "14/06/2013",
          parent_phone: "9800000011",
          photo_data: "",
        },
        adminHeaders,
      );
      assert.equal(cleared.status, 200);

      const resAfterClear = await req("/api/parent/students", undefined, {
        "x-parent-session": verified.data.sessionToken,
      });
      assert.equal(resAfterClear.data.students[0].photo_data, "");
      assert.equal(resAfterClear.data.students[0].mother_name, "");
    } finally {
      child.kill();
      await new Promise((r) => child.once("exit", r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
