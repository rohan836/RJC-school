const { test } = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { createWhatsApp } = require("../whatsapp");

test("malformed Unicode WhatsApp signatures return 401 without throwing", async () => {
  for (const name of [
    "WHATSAPP_TOKEN",
    "PHONE_NUMBER_ID",
    "WHATSAPP_APP_SECRET",
    "WHATSAPP_VERIFY_TOKEN",
  ])
    delete process.env[name];

  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE webhook_receipts(id TEXT PRIMARY KEY,status TEXT,serial_no TEXT,updated_at INTEGER)",
  );
  const wa = createWhatsApp(
    {
      db,
      issue() {},
      decorate: async (cert) => cert,
      pdf: async () => Buffer.alloc(0),
    },
    {},
  );
  let status = 0;
  const res = {
    sendStatus(value) {
      status = value;
      return this;
    },
    status(value) {
      status = value;
      return this;
    },
    json() {
      return this;
    },
  };

  try {
    await assert.doesNotReject(() =>
      wa.receive(
        {
          body: { object: "whatsapp_business_account", entry: [] },
          rawBody: Buffer.from("{}"),
          headers: { "x-hub-signature-256": "sha256=" + "💣".repeat(32) },
        },
        res,
      ),
    );
    assert.equal(status, 401);
  } finally {
    wa.close();
    db.close();
  }
});
