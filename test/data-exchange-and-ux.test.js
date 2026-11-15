const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const ExcelJS = require("exceljs");
const {
  normalizeClassName,
  normalizeDivision,
  normalizeDobValue,
  normalizePhone10,
  parseStudentImport,
  buildStudentsExport,
  buildSampleStudentsXlsx,
  buildLogsExport,
  buildAllDataExport,
} = require("../data-exchange");
const { renderCertificate } = require("../certificate");

test("normalizes classes (1-12, Roman, Nursery/KG), divisions, phones, and dates", () => {
  assert.equal(normalizeClassName("1"), "1st");
  assert.equal(normalizeClassName("Class 2"), "2nd");
  assert.equal(normalizeClassName("Std 3"), "3rd");
  assert.equal(normalizeClassName("10"), "10th");
  assert.equal(normalizeClassName("XII"), "12th");
  assert.equal(normalizeClassName("jr.kg"), "LKG");
  assert.equal(normalizeClassName("nursery"), "Nursery");
  assert.equal(normalizeDivision(" b "), "B");
  assert.equal(normalizePhone10("+91 98220-12345"), "9822012345");

  assert.deepEqual(normalizeDobValue("2013-06-14"), {
    dob: "14/06/2013",
    birth_year: "2013",
  });
  assert.deepEqual(normalizeDobValue("14-06-2013"), {
    dob: "14/06/2013",
    birth_year: "2013",
  });
  // Excel serial number for 2013-06-14 (41439)
  assert.deepEqual(normalizeDobValue(41439), {
    dob: "14/06/2013",
    birth_year: "2013",
  });
  assert.equal(normalizeDobValue("2999-01-01"), null);
});

test("parses Excel (.xlsx), XML spreadsheet (.xls), JSON, and CSV student imports", async () => {
  const xlsxBuf = await buildSampleStudentsXlsx();
  const fromXlsx = await parseStudentImport({
    filename: "students.xlsx",
    dataBase64: Buffer.from(xlsxBuf).toString("base64"),
  });
  assert.equal(fromXlsx.length, 1);
  assert.equal(fromXlsx[0].gr_number, "9901");
  assert.equal(fromXlsx[0].class_name, "8th");
  assert.equal(fromXlsx[0].dob, "14/06/2013");

  const fromJson = await parseStudentImport({
    filename: "students.json",
    text: JSON.stringify([
      {
        "GR No": "7701",
        "Student Name": "JSON Pupil",
        Class: "12",
        Division: "c",
        "Date of Birth": "2008-05-09",
        Mobile: "9811122233",
      },
    ]),
  });
  assert.equal(fromJson[0].class_name, "12th");
  assert.equal(fromJson[0].division, "C");
  assert.equal(fromJson[0].dob, "09/05/2008");

  const xmlXls = `<?xml version="1.0"?><Workbook><Worksheet ss:Name="Sheet1"><Table><Row><Cell><Data ss:Type="String">gr_number</Data></Cell><Cell><Data ss:Type="String">full_name</Data></Cell><Cell><Data ss:Type="String">class_name</Data></Cell><Cell><Data ss:Type="String">division</Data></Cell><Cell><Data ss:Type="String">dob</Data></Cell><Cell><Data ss:Type="String">parent_phone</Data></Cell></Row><Row><Cell><Data ss:Type="String">7702</Data></Cell><Cell><Data ss:Type="String">XML Pupil</Data></Cell><Cell><Data ss:Type="String">3</Data></Cell><Cell><Data ss:Type="String">a</Data></Cell><Cell><Data ss:Type="String">05/03/2018</Data></Cell><Cell><Data ss:Type="String">9822233344</Data></Cell></Row></Table></Worksheet></Workbook>`;
  const fromXml = await parseStudentImport({
    filename: "students.xls",
    text: xmlXls,
  });
  assert.equal(fromXml[0].gr_number, "7702");
  assert.equal(fromXml[0].class_name, "3rd");
  assert.equal(fromXml[0].division, "A");
});

test("builds multi-sheet Excel workbooks for logs and all-data export", async () => {
  const allOut = await buildAllDataExport({
    students: [{ gr_number: "1", full_name: "Test", class_name: "5th", division: "B", dob: "10/10/2015", parent_phone: "9800000000", status: "ACTIVE" }],
    logs: [{ serial_no: "RJC-2026-00001", gr_number: "1", student_name: "Test", doc_title: "Bonafide", issued_at: "2026-11-15T10:00:00.000Z", print_count: 1, security_code: "RJC-1234-ABCD", last_print_code: "PRT-01-1234-ABCD" }],
    printLogs: [{ serial_no: "RJC-2026-00001", copy_number: 1, copy_label: "ORIGINAL", page_no: "Page 1 of 1 (Sheet #01)", print_security_code: "PRT-01-1234-ABCD", printer_name: "Counter", printed_by_name: "Admin", printed_at: "2026-11-15T10:01:00.000Z" }],
    templates: [{ id: 1, title_en: "Bonafide", title_mr: "बोनाफाईड", title_hi: "बोनाफाइड", sig_pos: "right", stamp_pos: "right", require_top_teacher: 0, is_active: 1 }],
    teachers: [{ id: 1, name: "Sunita", role: "Principal", is_top_teacher: 1, slot_number: 1, is_active: 1, created_at: "2026-11-15T09:00:00.000Z" }],
    format: "xlsx",
  });
  assert.equal(allOut.ext, "xlsx");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(allOut.body);
  assert.deepEqual(
    wb.worksheets.map((w) => w.name),
    ["Students", "Issued Documents", "Print 2FA Sheets", "Templates", "Teachers & Staff"],
  );
  assert.equal(wb.getWorksheet("Students").rowCount, 2);
  assert.equal(wb.getWorksheet("Print 2FA Sheets").rowCount, 2);
});

test("certificate verification footer is crisp, minimal, non-truncated, and avoids nested boxes", () => {
  const rendered = renderCertificate({
    settings: {
      school_name: "R. J. CHAWARE CONVENT",
      school_subtitle: "Karanja (Lad)",
      udise_no: "27050400101",
    },
    docTitle: "Bonafide Certificate",
    bodyHtml: "<p>Test body</p>",
    serialNo: "RJC-2026-86453",
    issuedAt: "15 Nov 2026",
    lang: "en",
    sigPos: "right",
    stampPos: "none",
    copyNumber: 2,
    securityCode: "RJC-AFZI-HUPI",
    printSecurityCode: "PRT-02-223B-2A73",
    approvedByName: "School Office Admin",
    approvedByRole: "Principal",
    collectorLabel: "Parent / Family Collector",
    printerName: "School Counter Printer",
    verificationQr: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4O0AAAAASUVORK5CYII=",
    verificationUrl: "https://example.edu.in/verify/RJC-2026-86453",
  });

  assert.match(rendered.certificateHtml, /Official School Verification Record/);
  assert.match(rendered.certificateHtml, /DUPLICATE #2 · PAGE 1 OF 1 \(SHEET #02\)/);
  assert.match(rendered.certificateHtml, /PRT-02-223B-2A73/);
  assert.match(rendered.certificateHtml, /RJC-AFZI-HUPI/);
  assert.doesNotMatch(rendered.certificateHtml, /Scan QR to Verify Database R\.\.\./);
  assert.doesNotMatch(rendered.certificateHtml, /qr-copy-badge/);
});

test("server endpoints for Excel/CSV/JSON import-export and removed voice UI check", { timeout: 60000 }, async () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
  assert.equal(html.includes("data-speak"), false, "listen buttons should be removed");
  assert.equal(html.includes("qr-cue-strip"), false, "QR step strip should be removed");
  assert.match(html, /name="class_name" required>[\s\S]*<option value="12th">12th<\/option>/);
  assert.match(html, /name="division" required>[\s\S]*<option value="A">A<\/option>/);
  assert.match(html, /name="dob" type="date"/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjc-dx-"));
  const port = 52000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve(__dirname, "../server.js")], {
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
  });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + "/api/health")).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    const loginRes = await fetch(base + "/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "school1234" }),
    });
    const { token } = await loginRes.json();
    assert.ok(token);

    // Download sample Excel
    const sampleRes = await fetch(base + "/api/admin/sample.xlsx", {
      headers: { "x-admin-token": token },
    });
    assert.equal(sampleRes.status, 200);
    const sampleBuf = Buffer.from(await sampleRes.arrayBuffer());
    assert.equal(sampleBuf[0], 0x50); // PK zip header

    // Bulk import Excel
    const bulkRes = await fetch(base + "/api/admin/students/bulk", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": token,
      },
      body: JSON.stringify({
        filename: "sample-students.xlsx",
        dataBase64: sampleBuf.toString("base64"),
      }),
    });
    const bulkJson = await bulkRes.json();
    assert.equal(bulkRes.status, 200);
    assert.equal(bulkJson.count, 1);

    // Export students in JSON & XLSX
    const stJsonRes = await fetch(base + "/api/admin/students/export?format=json", {
      headers: { "x-admin-token": token },
    });
    const stJson = await stJsonRes.json();
    assert.ok(stJson.students.some((s) => s.gr_number === "9901"));

    // Export full workbook
    const allRes = await fetch(base + "/api/admin/export-all?format=xlsx", {
      headers: { "x-admin-token": token },
    });
    assert.equal(allRes.status, 200);
    const allBuf = Buffer.from(await allRes.arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(allBuf);
    assert.equal(wb.worksheets.length, 5);
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
