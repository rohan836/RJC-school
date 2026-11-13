const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase } = require("../db");
const { renderCertificate } = require("../certificate");

test("custom branding survives migration and UDISE renders with one prefix", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-udise-"));
  let db;
  try {
    db = openDatabase(dir);
    db.prepare(
      "UPDATE school_settings SET school_name=?,school_subtitle=?,udise_no=? WHERE id=1",
    ).run("Synthetic School", "Configured subtitle", " UDISE: 12345678901 ");
    db.pragma("user_version = 1");
    db.close();

    db = openDatabase(dir);
    const settings = db
      .prepare("SELECT * FROM school_settings WHERE id=1")
      .get();
    assert.equal(settings.school_name, "Synthetic School");
    assert.equal(settings.school_subtitle, "Configured subtitle");
    assert.equal(settings.udise_no, "12345678901");

    const rendered = renderCertificate({
      serialNo: "RJC-2026-12345",
      issuedAt: "13 Nov 2026",
      docTitle: "Sample certificate",
      bodyHtml: "<p>Sample</p>",
      sigPos: "right",
      stampPos: "center",
      lang: "en",
      settings,
      verificationUrl: "http://localhost:3000/verify/RJC-2026-12345",
      verificationQr: "data:image/png;base64,c2FtcGxl",
    });
    assert.match(
      rendered.certificateBody,
      /<small>UDISE: 12345678901<\/small>/,
    );
    assert.equal((rendered.certificateBody.match(/UDISE:/g) || []).length, 1);
  } finally {
    if (db?.open) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
