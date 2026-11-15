"use strict";

const ExcelJS = require("exceljs");
const { parse } = require("csv-parse/sync");

const CLASS_OPTIONS = [
  "Nursery",
  "LKG",
  "UKG",
  "1st",
  "2nd",
  "3rd",
  "4th",
  "5th",
  "6th",
  "7th",
  "8th",
  "9th",
  "10th",
  "11th",
  "12th",
];

const DIVISION_OPTIONS = ["A", "B", "C", "D", "E"];

const STUDENT_EXPORT_COLUMNS = [
  { key: "gr_number", header: "gr_number", label: "GR Number", width: 14 },
  { key: "full_name", header: "full_name", label: "Student Name", width: 28 },
  { key: "father_name", header: "father_name", label: "Father / Parent Name", width: 24 },
  { key: "mother_name", header: "mother_name", label: "Mother Name", width: 22 },
  { key: "class_name", header: "class_name", label: "Class", width: 12 },
  { key: "division", header: "division", label: "Division", width: 10 },
  { key: "dob", header: "dob", label: "Birth Date (DD/MM/YYYY)", width: 20 },
  { key: "aadhaar_last4", header: "aadhaar_last4", label: "Aadhaar Last 4", width: 15 },
  { key: "parent_phone", header: "parent_phone", label: "Parent Mobile", width: 16 },
  { key: "parent_email", header: "parent_email", label: "Parent Email", width: 26 },
  { key: "roll_no", header: "roll_no", label: "Roll No", width: 10 },
  { key: "academic_year", header: "academic_year", label: "Academic Year", width: 15 },
  { key: "blood_group", header: "blood_group", label: "Blood Group", width: 12 },
  { key: "house", header: "house", label: "House", width: 14 },
  { key: "apaar_id", header: "apaar_id", label: "APAAR ID", width: 18 },
  { key: "emergency_phone", header: "emergency_phone", label: "Emergency Mobile", width: 16 },
  { key: "bus_route", header: "bus_route", label: "Bus Route", width: 16 },
  { key: "address", header: "address", label: "Address", width: 30 },
  { key: "remarks", header: "remarks", label: "Remarks", width: 22 },
  { key: "status", header: "status", label: "Status", width: 12 },
];

const HEADER_ALIASES = {
  gr: "gr_number",
  grno: "gr_number",
  grnumber: "gr_number",
  generalregister: "gr_number",
  regno: "gr_number",
  admissionno: "gr_number",
  studentname: "full_name",
  fullname: "full_name",
  name: "full_name",
  pupilname: "full_name",
  fathername: "father_name",
  father: "father_name",
  fatherparentname: "father_name",
  mothername: "mother_name",
  mother: "mother_name",
  classname: "class_name",
  class: "class_name",
  std: "class_name",
  standard: "class_name",
  grade: "class_name",
  division: "division",
  div: "division",
  sec: "division",
  section: "division",
  dob: "dob",
  birthdate: "dob",
  dateofbirth: "dob",
  birthdate_ddmmyyyy: "dob",
  birthdateddmmyyyy: "dob",
  aadhaarlast4: "aadhaar_last4",
  aadharlast4: "aadhaar_last4",
  aadhaar: "aadhaar_last4",
  parentphone: "parent_phone",
  parentmobile: "parent_phone",
  mobile: "parent_phone",
  phone: "parent_phone",
  contact: "parent_phone",
  parentemail: "parent_email",
  email: "parent_email",
  rollno: "roll_no",
  roll: "roll_no",
  academicyear: "academic_year",
  year: "academic_year",
  bloodgroup: "blood_group",
  house: "house",
  apaarid: "apaar_id",
  apaar: "apaar_id",
  emergencyphone: "emergency_phone",
  emergencymobile: "emergency_phone",
  busroute: "bus_route",
  transportroute: "bus_route",
  address: "address",
  remarks: "remarks",
  note: "remarks",
  status: "status",
};

const ROMAN_TO_INT = {
  I: 1,
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7,
  VIII: 8,
  IX: 9,
  X: 10,
  XI: 11,
  XII: 12,
};

function ordinalClass(num) {
  if (num === 1) return "1st";
  if (num === 2) return "2nd";
  if (num === 3) return "3rd";
  return `${num}th`;
}

function normalizeClassName(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const compact = raw
    .replace(/^(class|std|standard|grade)\.?\s*/i, "")
    .trim();
  const upper = compact.toUpperCase();
  if (upper === "NURSERY" || upper === "NUR") return "Nursery";
  if (upper === "LKG" || upper === "JRKG" || upper === "JR.KG") return "LKG";
  if (upper === "UKG" || upper === "SRKG" || upper === "SR.KG") return "UKG";
  if (ROMAN_TO_INT[upper]) return ordinalClass(ROMAN_TO_INT[upper]);
  const numMatch = /^(\d{1,2})(?:st|nd|rd|th)?$/i.exec(compact);
  if (numMatch) {
    const n = Number(numMatch[1]);
    if (n >= 1 && n <= 12) return ordinalClass(n);
  }
  return raw;
}

function normalizeDivision(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizePhone10(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

function formatDateParts(day, month, year) {
  const d = new Date(year, month - 1, day);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 1900 ||
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day ||
    d > new Date()
  ) {
    return null;
  }
  return {
    dob: `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${String(year)}`,
    birth_year: String(year),
  };
}

/**
 * Accepts Date instances, Excel serial numbers, YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, or DD.MM.YYYY.
 */
function normalizeDobValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDateParts(
      value.getUTCDate(),
      value.getUTCMonth() + 1,
      value.getUTCFullYear(),
    );
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 1000 && value < 100000) {
    // Excel epoch: 1899-12-30 UTC
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const dt = new Date(ms);
    if (!Number.isNaN(dt.getTime())) {
      return formatDateParts(
        dt.getUTCDate(),
        dt.getUTCMonth() + 1,
        dt.getUTCFullYear(),
      );
    }
  }
  const s = String(value ?? "").trim();
  if (!s) return null;

  // ISO: YYYY-MM-DD or YYYY/MM/DD
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) {
    return formatDateParts(Number(m[3]), Number(m[2]), Number(m[1]));
  }

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) {
    return formatDateParts(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  return null;
}

function canonicalHeaderKey(rawHeader) {
  const cleaned = String(rawHeader ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return HEADER_ALIASES[cleaned] || String(rawHeader ?? "").trim();
}

function cellToPrimitive(val) {
  if (val === null || val === undefined) return "";
  if (val instanceof Date) return val;
  if (typeof val === "object") {
    if (Array.isArray(val.richText)) {
      return val.richText.map((part) => part.text || "").join("");
    }
    if ("result" in val) return cellToPrimitive(val.result);
    if ("text" in val) return String(val.text ?? "");
    if ("hyperlink" in val) return String(val.text ?? val.hyperlink ?? "");
  }
  return val;
}

function normalizeStudentRow(rawRow) {
  const mapped = {};
  for (const [k, v] of Object.entries(rawRow || {})) {
    const targetKey = canonicalHeaderKey(k);
    if (targetKey && mapped[targetKey] === undefined) {
      mapped[targetKey] = cellToPrimitive(v);
    }
  }
  const dobParsed = normalizeDobValue(mapped.dob);
  return {
    gr_number: String(mapped.gr_number ?? "").trim(),
    full_name: String(mapped.full_name ?? "").trim(),
    father_name: String(mapped.father_name ?? "").trim(),
    mother_name: String(mapped.mother_name ?? "").trim(),
    class_name: normalizeClassName(mapped.class_name),
    division: normalizeDivision(mapped.division),
    dob: dobParsed ? dobParsed.dob : String(mapped.dob ?? "").trim(),
    aadhaar_last4: String(mapped.aadhaar_last4 ?? "").replace(/\D/g, "").slice(-4),
    parent_phone: normalizePhone10(mapped.parent_phone),
    parent_email: String(mapped.parent_email ?? "").trim(),
    roll_no: String(mapped.roll_no ?? "").trim(),
    academic_year: String(mapped.academic_year ?? "").trim(),
    blood_group: String(mapped.blood_group ?? "").trim(),
    house: String(mapped.house ?? "").trim(),
    apaar_id: String(mapped.apaar_id ?? "").trim(),
    emergency_phone: normalizePhone10(mapped.emergency_phone),
    bus_route: String(mapped.bus_route ?? "").trim(),
    address: String(mapped.address ?? "").trim(),
    remarks: String(mapped.remarks ?? "").trim(),
    photo_data: String(mapped.photo_data ?? "").trim(),
    status: String(mapped.status ?? "").trim().toUpperCase() === "INACTIVE" ? "INACTIVE" : "ACTIVE",
  };
}

function parseSpreadsheetXmlRows(xmlText) {
  const rows = [];
  const rowMatches = [...String(xmlText || "").matchAll(/<Row\b[^>]*>([\s\S]*?)<\/Row>/gi)];
  for (const rm of rowMatches) {
    const cells = [];
    const cellMatches = [...rm[1].matchAll(/<Cell\b([^>]*)>([\s\S]*?)<\/Cell>/gi)];
    for (const cm of cellMatches) {
      const idxMatch = /ss:Index="(\d+)"/i.exec(cm[1]);
      if (idxMatch) {
        const targetIdx = Number(idxMatch[1]) - 1;
        while (cells.length < targetIdx) cells.push("");
      }
      const dataMatch = /<Data\b[^>]*>([\s\S]*?)<\/Data>/i.exec(cm[2]);
      const val = dataMatch
        ? dataMatch[1]
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, "&")
            .trim()
        : "";
      cells.push(val);
    }
    if (cells.some((c) => c !== "")) rows.push(cells);
  }
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((vals) => {
    const obj = {};
    headers.forEach((h, i) => {
      if (h) obj[h] = vals[i] ?? "";
    });
    return obj;
  });
}

function parseHtmlTableRows(htmlText) {
  const rows = [];
  const trMatches = [...String(htmlText || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  for (const tr of trMatches) {
    const cells = [...tr[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((m) =>
      m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/gi, " ").trim(),
    );
    if (cells.some((c) => c !== "")) rows.push(cells);
  }
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((vals) => {
    const obj = {};
    headers.forEach((h, i) => {
      if (h) obj[h] = vals[i] ?? "";
    });
    return obj;
  });
}

/**
 * Parses CSV, TSV, JSON, Excel (.xlsx), XML Spreadsheet, or HTML-XLS into normalized student objects.
 */
async function parseStudentImport({ filename = "", dataBase64 = "", text = "", format = "" }) {
  const ext = String(format || pathExt(filename)).toLowerCase().replace(/^\./, "");
  let rawRows = [];

  if (dataBase64 && (ext === "xlsx" || isZipBase64(dataBase64))) {
    const buf = Buffer.from(dataBase64, "base64");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const sheet = wb.getWorksheet("Students") || wb.worksheets[0];
    if (!sheet) throw new Error("Excel workbook has no worksheets.");
    const headerRow = sheet.getRow(1);
    const headers = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      headers[colNumber] = String(cellToPrimitive(cell.value) ?? "").trim();
    });
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const obj = {};
      let hasData = false;
      headers.forEach((h, colNumber) => {
        if (!h) return;
        const val = cellToPrimitive(row.getCell(colNumber).value);
        if (val !== "" && val !== null && val !== undefined) hasData = true;
        obj[h] = val;
      });
      if (hasData) rawRows.push(obj);
    });
  } else {
    const rawText =
      typeof text === "string" && text.length
        ? text
        : dataBase64
          ? Buffer.from(dataBase64, "base64").toString("utf8")
          : "";
    const trimmed = rawText.trim();
    if (!trimmed) throw new Error("Import file is empty.");

    if (ext === "json" || trimmed.startsWith("[") || trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) rawRows = parsed;
      else if (Array.isArray(parsed?.students)) rawRows = parsed.students;
      else throw new Error("JSON must be an array of students or contain a 'students' array.");
    } else if (/^<\?xml|<Workbook/i.test(trimmed)) {
      rawRows = parseSpreadsheetXmlRows(trimmed);
    } else if (/^<html|^<table/i.test(trimmed)) {
      rawRows = parseHtmlTableRows(trimmed);
    } else {
      const firstLine = trimmed.split(/\r?\n/)[0] || "";
      const delimiter = firstLine.includes("\t")
        ? "\t"
        : firstLine.includes(";") && !firstLine.includes(",")
          ? ";"
          : ",";
      rawRows = parse(trimmed, {
        columns: true,
        skip_empty_lines: true,
        bom: true,
        trim: true,
        delimiter,
      });
    }
  }

  return rawRows.map((row) => normalizeStudentRow(row));
}

function pathExt(name) {
  const idx = String(name || "").lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1) : "";
}

function isZipBase64(b64) {
  try {
    const head = Buffer.from(String(b64).slice(0, 12), "base64");
    return head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b; // PK
  } catch {
    return false;
  }
}

const csvCell = (value) => {
  const s = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

function styleHeaderRow(sheet) {
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF141414" } };
  row.alignment = { vertical: "middle" };
  row.height = 22;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

async function buildStudentsExport({ students = [], format = "xlsx" }) {
  const fmt = String(format || "xlsx").toLowerCase();
  if (fmt === "json") {
    return {
      contentType: "application/json; charset=utf-8",
      ext: "json",
      body: Buffer.from(
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            count: students.length,
            students: students.map(({ photo_data: _omit, ...rest }) => rest),
          },
          null,
          2,
        ),
        "utf8",
      ),
    };
  }
  if (fmt === "csv") {
    const header = STUDENT_EXPORT_COLUMNS.map((c) => c.header).join(",");
    const lines = students.map((s) =>
      STUDENT_EXPORT_COLUMNS.map((c) => csvCell(s[c.key] ?? "")).join(","),
    );
    return {
      contentType: "text/csv; charset=utf-8",
      ext: "csv",
      body: Buffer.from("\uFEFF" + [header, ...lines].join("\r\n") + "\r\n", "utf8"),
    };
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = "RJC School Document Portal";
  wb.created = new Date();
  const sheet = wb.addWorksheet("Students");
  sheet.columns = STUDENT_EXPORT_COLUMNS.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width,
  }));
  for (const s of students) {
    const row = {};
    for (const c of STUDENT_EXPORT_COLUMNS) row[c.key] = s[c.key] ?? "";
    sheet.addRow(row);
  }
  styleHeaderRow(sheet);
  const buf = await wb.xlsx.writeBuffer();
  return {
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: "xlsx",
    body: Buffer.from(buf),
  };
}

async function buildSampleStudentsXlsx() {
  const sample = [
    {
      gr_number: "9901",
      full_name: "Sample Student Patil",
      father_name: "Sample Parent Patil",
      mother_name: "Sunita Patil",
      class_name: "8th",
      division: "A",
      dob: "14/06/2013",
      aadhaar_last4: "1234",
      parent_phone: "9800000001",
      parent_email: "parent@example.com",
      status: "ACTIVE",
    },
  ];
  return (await buildStudentsExport({ students: sample, format: "xlsx" })).body;
}

const LOG_COLUMNS = [
  { key: "serial_no", header: "Document Ref", width: 18 },
  { key: "gr_number", header: "GR Number", width: 12 },
  { key: "student_name", header: "Student Name", width: 26 },
  { key: "doc_title", header: "Document Title", width: 22 },
  { key: "security_code", header: "Crypto Seal", width: 16 },
  { key: "last_print_code", header: "Latest Print 2FA Code", width: 20 },
  { key: "print_count", header: "Copies Printed", width: 14 },
  { key: "printer_name", header: "Printer", width: 22 },
  { key: "approved_by_name", header: "Approved By", width: 20 },
  { key: "approved_by_role", header: "Approver Role", width: 16 },
  { key: "collector_role", header: "Collector Role", width: 24 },
  { key: "verified_phone", header: "Verified Mobile", width: 16 },
  { key: "reason", header: "Reason / Purpose", width: 24 },
  { key: "supporting_doc_name", header: "Supporting Doc", width: 20 },
  { key: "scan_count", header: "QR Scans", width: 10 },
  { key: "last_scanned_at", header: "Latest Scan At", width: 22 },
  { key: "issued_year", header: "Year", width: 8 },
  { key: "issued_at", header: "Issued At", width: 24 },
];

function enrichLogRow(r) {
  return {
    ...r,
    collector_role: r.is_guardian
      ? "Authorized Guardian"
      : "Parent / Family Collector",
  };
}

async function buildLogsExport({ logs = [], printLogs = [], format = "xlsx" }) {
  const fmt = String(format || "xlsx").toLowerCase();
  const rows = logs.map(enrichLogRow);
  if (fmt === "json") {
    return {
      contentType: "application/json; charset=utf-8",
      ext: "json",
      body: Buffer.from(
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            count: rows.length,
            issuedDocuments: rows,
            printSheets: printLogs,
          },
          null,
          2,
        ),
        "utf8",
      ),
    };
  }
  if (fmt === "csv") {
    const csvKeys = [
      "serial_no",
      "gr_number",
      "student_name",
      "doc_title",
      "issued_year",
      "reason",
      "campus_code_used",
      "supporting_doc_name",
      "verified_phone",
      "is_guardian",
      "collector_role",
      "approved_by_name",
      "approved_by_role",
      "security_code",
      "last_print_code",
      "print_count",
      "printer_name",
      "scan_count",
      "last_scanned_at",
      "issued_at",
    ];
    const header = csvKeys.join(",");
    const lines = rows.map((r) =>
      csvKeys
        .map((k) =>
          csvCell(
            k === "is_guardian"
              ? r.is_guardian
                ? "Yes"
                : "No"
              : (r[k] ?? ""),
          ),
        )
        .join(","),
    );
    return {
      contentType: "text/csv; charset=utf-8",
      ext: "csv",
      body: Buffer.from("\uFEFF" + [header, ...lines].join("\r\n") + "\r\n", "utf8"),
    };
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "RJC School Document Portal";
  wb.created = new Date();
  const sheet = wb.addWorksheet("Issued Documents");
  sheet.columns = LOG_COLUMNS;
  for (const r of rows) sheet.addRow(r);
  styleHeaderRow(sheet);

  if (printLogs.length) {
    const pSheet = wb.addWorksheet("Print 2FA Sheets");
    pSheet.columns = [
      { key: "serial_no", header: "Document Ref", width: 18 },
      { key: "copy_number", header: "Copy #", width: 10 },
      { key: "copy_label", header: "Copy Status", width: 18 },
      { key: "page_no", header: "Page / Sheet No", width: 22 },
      { key: "print_security_code", header: "Print 2FA Code", width: 20 },
      { key: "printer_name", header: "Printer", width: 22 },
      { key: "printed_by_name", header: "Printed By", width: 20 },
      { key: "printed_at", header: "Printed At", width: 24 },
    ];
    for (const p of printLogs) pSheet.addRow(p);
    styleHeaderRow(pSheet);
  }

  const buf = await wb.xlsx.writeBuffer();
  return {
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: "xlsx",
    body: Buffer.from(buf),
  };
}

async function buildAllDataExport({
  students = [],
  logs = [],
  printLogs = [],
  templates = [],
  teachers = [],
  format = "xlsx",
}) {
  const fmt = String(format || "xlsx").toLowerCase();
  if (fmt === "json") {
    return {
      contentType: "application/json; charset=utf-8",
      ext: "json",
      body: Buffer.from(
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            students: students.map(({ photo_data: _omit, ...s }) => s),
            issuedDocuments: logs.map(enrichLogRow),
            printSheets: printLogs,
            templates,
            teachers,
          },
          null,
          2,
        ),
        "utf8",
      ),
    };
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "RJC School Document Portal";
  wb.created = new Date();

  const sSheet = wb.addWorksheet("Students");
  sSheet.columns = STUDENT_EXPORT_COLUMNS.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width,
  }));
  for (const s of students) sSheet.addRow(s);
  styleHeaderRow(sSheet);

  const lSheet = wb.addWorksheet("Issued Documents");
  lSheet.columns = LOG_COLUMNS;
  for (const r of logs.map(enrichLogRow)) lSheet.addRow(r);
  styleHeaderRow(lSheet);

  const pSheet = wb.addWorksheet("Print 2FA Sheets");
  pSheet.columns = [
    { key: "serial_no", header: "Document Ref", width: 18 },
    { key: "copy_number", header: "Copy #", width: 10 },
    { key: "copy_label", header: "Copy Status", width: 18 },
    { key: "page_no", header: "Page / Sheet No", width: 22 },
    { key: "print_security_code", header: "Print 2FA Code", width: 20 },
    { key: "printer_name", header: "Printer", width: 22 },
    { key: "printed_by_name", header: "Printed By", width: 20 },
    { key: "printed_at", header: "Printed At", width: 24 },
  ];
  for (const p of printLogs) pSheet.addRow(p);
  styleHeaderRow(pSheet);

  const tSheet = wb.addWorksheet("Templates");
  tSheet.columns = [
    { key: "id", header: "ID", width: 8 },
    { key: "title_en", header: "English Title", width: 24 },
    { key: "title_mr", header: "Marathi Title", width: 24 },
    { key: "title_hi", header: "Hindi Title", width: 24 },
    { key: "sig_pos", header: "Signature Pos", width: 14 },
    { key: "stamp_pos", header: "Stamp Pos", width: 14 },
    { key: "require_top_teacher", header: "Require Top Teacher", width: 18 },
    { key: "is_active", header: "Active", width: 10 },
  ];
  for (const t of templates) tSheet.addRow(t);
  styleHeaderRow(tSheet);

  const stSheet = wb.addWorksheet("Teachers & Staff");
  stSheet.columns = [
    { key: "id", header: "ID", width: 8 },
    { key: "name", header: "Name", width: 24 },
    { key: "role", header: "Role", width: 18 },
    { key: "is_top_teacher", header: "Top Teacher", width: 14 },
    { key: "slot_number", header: "Slot", width: 10 },
    { key: "is_active", header: "Active", width: 10 },
    { key: "created_at", header: "Created At", width: 24 },
  ];
  for (const m of teachers) stSheet.addRow(m);
  styleHeaderRow(stSheet);

  const buf = await wb.xlsx.writeBuffer();
  return {
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: "xlsx",
    body: Buffer.from(buf),
  };
}

module.exports = {
  CLASS_OPTIONS,
  DIVISION_OPTIONS,
  normalizeClassName,
  normalizeDivision,
  normalizeDobValue,
  normalizePhone10,
  normalizeStudentRow,
  parseStudentImport,
  buildStudentsExport,
  buildSampleStudentsXlsx,
  buildLogsExport,
  buildAllDataExport,
};
