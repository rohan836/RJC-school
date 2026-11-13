const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { openDatabase } = require("../db");
const { createWhatsApp } = require("../whatsapp");
test("signed multilingual WhatsApp flow uploads PDF, deduplicates retries and clears sessions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rgc-wa-"));
  const db = openDatabase(dir);
  process.env.WHATSAPP_APP_SECRET = "secret";
  const sends = [],
    issues = [];
  let failDelivery = false;
  const wa = createWhatsApp(
    {
      db,
      issue: (body, local) => {
        assert.equal(local, false);
        assert.equal(body.campusCode, "4321");
        assert.equal(body.birthYear, "2013");
        issues.push(body);
        const cert = {
          serialNo: "RJC-2026-" + (10000 + issues.length),
          lang: body.lang,
        };
        db.prepare(
          "INSERT INTO issued_logs(serial_no,certificate_json) VALUES(?,?)",
        ).run(cert.serialNo, JSON.stringify(cert));
        return cert;
      },
      decorate: async (c) => ({ ...c, certificateHtml: "<p>PDF</p>" }),
      pdf: async () => Buffer.from("%PDF-test"),
    },
    {
      send: async (to, m) => {
        if (failDelivery && m.type === "document") {
          failDelivery = false;
          throw Error("temporary failure");
        }
        sends.push({ to, ...m });
      },
      upload: async (buffer, name) => {
        assert.match(buffer.toString(), /^%PDF/);
        assert.match(name, /\.pdf$/);
        return "media-id";
      },
    },
  );
  let n = 0;
  const message = async (value, id = "id-" + ++n, sig = true) => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id,
                    from: "919822011111",
                    ...(value.startsWith("lang_") ||
                    value.startsWith("student_") ||
                    value.startsWith("template_")
                      ? { interactive: { button_reply: { id: value } } }
                      : { text: { body: value } }),
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const raw = Buffer.from(JSON.stringify(body));
    let status = 200;
    const res = {
      status(x) {
        status = x;
        return this;
      },
      sendStatus(x) {
        status = x;
      },
      json() {},
      send() {},
    };
    await wa.receive(
      {
        body,
        rawBody: raw,
        headers: {
          "x-hub-signature-256": sig
            ? "sha256=" +
              crypto.createHmac("sha256", "secret").update(raw).digest("hex")
            : "invalid",
        },
      },
      res,
    );
    return status;
  };
  try {
    assert.equal(await message("Hi", "bad", false), 401);
    assert.equal(await message("Hi"), 200);
    assert.equal(sends.at(-1).interactive.type, "button");
    await message("lang_mr");
    assert.match(sends.at(-1).text.body, /मोबाईल/);
    await message("9822011111");
    assert.equal(sends.at(-1).interactive.type, "list");
    await message("student_4501");
    await message("2013");
    await message("4321");
    await message("template_1", "document-1");
    assert.equal(sends.at(-1).type, "document");
    assert.equal(wa.sessionCount(), 0);
    assert.equal(issues.length, 1);
    await message("template_1", "document-1");
    assert.equal(issues.length, 1);
    await message("lang_hi");
    await message("9822011111");
    await message("student_4501");
    await message("2013");
    await message("4321");
    failDelivery = true;
    assert.equal(await message("template_1", "retry-me"), 503);
    assert.equal(wa.sessionCount(), 0);
    assert.equal(await message("template_1", "retry-me"), 200);
    assert.equal(issues.length, 2);
    assert.equal(sends.at(-1).document.id, "media-id");
    assert.match(sends.at(-1).document.caption, /प्रमाणपत्र/);
    await message("lang_en");
    await message("1111111111");
    assert.equal(wa.sessionCount(), 0);
    assert.match(sends.at(-1).text.body, /No active student/);
  } finally {
    wa.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
