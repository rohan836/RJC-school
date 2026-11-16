const Database = require("better-sqlite3");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
// Real school identity. BRAND is what a fresh install starts with; LEGACY_BRAND is
// the placeholder that earlier versions seeded, so the migration can recognise and
// replace it without touching branding a school administrator has already changed.
const BRAND = {
  schoolName: "R. J. CHAWARE CONVENT",
  schoolSubtitle:
    "Jain Minority Institute • Karanja Education Society's • Chaware Line, Karanja (Lad), Dist. Washim, Maharashtra 444105",
};
const LEGACY_BRAND = {
  schoolName: "SHREE VIDYA MANDIR HIGH SCHOOL, NASHIK",
  schoolSubtitle:
    "Recognized by Govt. of Maharashtra • Marathi & Semi-English Medium",
};
const MONOGRAM = "RJC";
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(password, salt, 64).toString("hex");
}
function checkPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(":");
    const actual = crypto.scryptSync(password, salt, 64);
    return (
      actual.length === Buffer.from(hash, "hex").length &&
      crypto.timingSafeEqual(actual, Buffer.from(hash, "hex"))
    );
  } catch {
    return false;
  }
}
function openDatabase(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "school.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS admin_users(id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT);
 CREATE TABLE IF NOT EXISTS school_settings(id INTEGER PRIMARY KEY CHECK(id=1), school_name TEXT, school_subtitle TEXT, udise_no TEXT, whatsapp_number TEXT, logo_data TEXT, signature_data TEXT, stamp_data TEXT);
 CREATE TABLE IF NOT EXISTS students(gr_number TEXT PRIMARY KEY, full_name TEXT NOT NULL, father_name TEXT, class_name TEXT NOT NULL, division TEXT NOT NULL, dob TEXT NOT NULL, birth_year TEXT NOT NULL, parent_phone TEXT NOT NULL, status TEXT DEFAULT 'ACTIVE');
 CREATE TABLE IF NOT EXISTS document_templates(id INTEGER PRIMARY KEY AUTOINCREMENT,title_mr TEXT NOT NULL,title_hi TEXT NOT NULL,title_en TEXT NOT NULL,body_html TEXT NOT NULL,sig_pos TEXT DEFAULT 'right',stamp_pos TEXT DEFAULT 'center',is_active INTEGER DEFAULT 1);
 CREATE TABLE IF NOT EXISTS issued_logs(serial_no TEXT PRIMARY KEY, gr_number TEXT, student_name TEXT, doc_title TEXT, verified_phone TEXT,is_guardian INTEGER DEFAULT 0,issued_at TEXT);
 CREATE TABLE IF NOT EXISTS verification_attempts(gr_number TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS webhook_receipts(id TEXT PRIMARY KEY, status TEXT NOT NULL, serial_no TEXT, updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS teachers(
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   slot_number INTEGER DEFAULT 0,
   name TEXT NOT NULL,
   role TEXT NOT NULL DEFAULT 'Staff',
   is_top_teacher INTEGER NOT NULL DEFAULT 0,
   telegram_chat_id TEXT DEFAULT '',
   telegram_username TEXT DEFAULT '',
   pin_hash TEXT DEFAULT '',
   is_active INTEGER NOT NULL DEFAULT 1,
   joined_via_bot INTEGER NOT NULL DEFAULT 0,
   created_at TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS qr_handoff_tokens(
   token TEXT PRIMARY KEY,
   status TEXT NOT NULL DEFAULT 'ACTIVE',
   mobile_session_id TEXT DEFAULT '',
   issued_at INTEGER NOT NULL,
   expires_at INTEGER NOT NULL,
   used_at INTEGER DEFAULT 0
 );
 CREATE TABLE IF NOT EXISTS approval_requests(
   id TEXT PRIMARY KEY,
   gr_number TEXT NOT NULL,
   student_name TEXT NOT NULL,
   template_id INTEGER NOT NULL,
   doc_title TEXT NOT NULL,
   lang TEXT NOT NULL DEFAULT 'en',
   verified_phone TEXT DEFAULT '',
   auth_method TEXT DEFAULT 'family',
   is_guardian INTEGER NOT NULL DEFAULT 0,
   guardian_phone TEXT DEFAULT '',
   parent_photo_data TEXT DEFAULT '',
   supporting_doc_name TEXT DEFAULT '',
   supporting_doc_mime TEXT DEFAULT '',
   supporting_doc_data TEXT DEFAULT '',
   status TEXT NOT NULL DEFAULT 'PENDING',
   approved_by_teacher_id INTEGER,
   reviewed_by_name TEXT DEFAULT '',
   reviewed_by_role TEXT DEFAULT '',
   review_channel TEXT DEFAULT '',
   rejection_reason TEXT DEFAULT '',
   serial_no TEXT DEFAULT '',
   print_status TEXT NOT NULL DEFAULT 'WAITING',
   print_error TEXT DEFAULT '',
   telegram_messages_json TEXT DEFAULT '[]',
   created_at TEXT NOT NULL,
   reviewed_at TEXT DEFAULT '',
   printed_at TEXT DEFAULT ''
 );
 CREATE TABLE IF NOT EXISTS qr_scans(
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   serial_no TEXT NOT NULL,
   scanned_at TEXT NOT NULL,
   source_hint TEXT DEFAULT ''
 );
 CREATE TABLE IF NOT EXISTS print_logs(
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   serial_no TEXT NOT NULL,
   request_id TEXT DEFAULT '',
   copy_number INTEGER NOT NULL DEFAULT 1,
   copy_label TEXT NOT NULL DEFAULT 'ORIGINAL',
   printer_name TEXT DEFAULT '',
   printed_by_name TEXT DEFAULT '',
   printed_at TEXT NOT NULL
 );`);
  const add = (table, name, type) => {
    if (!db.pragma(`table_info(${table})`).some((c) => c.name === name))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  };
  db.transaction(() => {
    add("students", "aadhaar_last4", "TEXT DEFAULT ''");
    add("students", "mother_name", "TEXT DEFAULT ''");
    add("students", "roll_no", "TEXT DEFAULT ''");
    add("students", "academic_year", "TEXT DEFAULT ''");
    add("students", "blood_group", "TEXT DEFAULT ''");
    add("students", "house", "TEXT DEFAULT ''");
    add("students", "apaar_id", "TEXT DEFAULT ''");
    add("students", "emergency_phone", "TEXT DEFAULT ''");
    add("students", "bus_route", "TEXT DEFAULT ''");
    add("students", "address", "TEXT DEFAULT ''");
    add("students", "remarks", "TEXT DEFAULT ''");
    add("students", "photo_data", "TEXT DEFAULT ''");
    add("students", "parent_email", "TEXT DEFAULT ''");
    add("school_settings", "wifi_ssid", "TEXT DEFAULT ''");
    add("school_settings", "wifi_password", "TEXT DEFAULT ''");
    add("school_settings", "public_url", "TEXT DEFAULT ''");
    add("school_settings", "public_verify_url", "TEXT DEFAULT ''");
    add("school_settings", "allow_public_teacher", "INTEGER NOT NULL DEFAULT 0");
    add("school_settings", "telegram_bot_token", "TEXT DEFAULT ''");
    add("school_settings", "telegram_storage_chat_id", "TEXT DEFAULT ''");
    add("school_settings", "staff_join_code", "TEXT DEFAULT ''");
    add("school_settings", "auto_print_mode", "TEXT DEFAULT 'browser_kiosk'");
    add("school_settings", "printer_name", "TEXT DEFAULT ''");
    add("school_settings", "telegram_update_offset", "INTEGER DEFAULT 0");
    add("school_settings", "staff_print_confirm", "INTEGER NOT NULL DEFAULT 0");
    add("school_settings", "notify_qr_scans", "INTEGER NOT NULL DEFAULT 1");
    add("school_settings", "smtp_host", "TEXT DEFAULT ''");
    add("school_settings", "smtp_port", "INTEGER DEFAULT 587");
    add("school_settings", "smtp_user", "TEXT DEFAULT ''");
    add("school_settings", "smtp_pass", "TEXT DEFAULT ''");
    add("school_settings", "smtp_from", "TEXT DEFAULT ''");
    add("document_templates", "body_mr", "TEXT DEFAULT ''");
    add("document_templates", "body_hi", "TEXT DEFAULT ''");
    add("document_templates", "require_top_teacher", "INTEGER NOT NULL DEFAULT 0");
    add("issued_logs", "certificate_json", "TEXT");
    add("issued_logs", "download_hash", "TEXT");
    add("issued_logs", "reason", "TEXT DEFAULT ''");
    add("issued_logs", "supporting_doc_name", "TEXT DEFAULT ''");
    add("issued_logs", "supporting_doc_mime", "TEXT DEFAULT ''");
    add("issued_logs", "supporting_doc_data", "TEXT DEFAULT ''");
    add("issued_logs", "request_id", "TEXT DEFAULT ''");
    add("issued_logs", "approved_by_name", "TEXT DEFAULT ''");
    add("issued_logs", "approved_by_role", "TEXT DEFAULT ''");
    add("issued_logs", "parent_photo_data", "TEXT DEFAULT ''");
    add("issued_logs", "scan_count", "INTEGER NOT NULL DEFAULT 0");
    add("issued_logs", "last_scanned_at", "TEXT DEFAULT ''");
    add("issued_logs", "issued_year", "INTEGER DEFAULT 0");
    add("issued_logs", "doc_signature", "TEXT DEFAULT ''");
    add("issued_logs", "security_code", "TEXT DEFAULT ''");
    add("school_settings", "verification_secret", "TEXT DEFAULT ''");
    add("school_settings", "telegram_topic_pending", "TEXT DEFAULT ''");
    add("school_settings", "telegram_topic_approved", "TEXT DEFAULT ''");
    add("school_settings", "telegram_topic_scans", "TEXT DEFAULT ''");
    add("school_settings", "whatsapp_token", "TEXT DEFAULT ''");
    add("school_settings", "whatsapp_phone_id", "TEXT DEFAULT ''");
    add("school_settings", "whatsapp_ready_template", "TEXT DEFAULT ''");
    add("approval_requests", "notification_status", "TEXT DEFAULT ''");
    add("approval_requests", "notified_at", "TEXT DEFAULT ''");
    add("approval_requests", "reason", "TEXT DEFAULT ''");
    add("approval_requests", "campus_code_used", "TEXT DEFAULT ''");
    add("approval_requests", "print_count", "INTEGER NOT NULL DEFAULT 0");
    add("approval_requests", "printer_name", "TEXT DEFAULT ''");
    add("approval_requests", "printed_by_name", "TEXT DEFAULT ''");
    add("issued_logs", "print_count", "INTEGER NOT NULL DEFAULT 0");
    add("issued_logs", "printer_name", "TEXT DEFAULT ''");
    add("issued_logs", "printed_by_name", "TEXT DEFAULT ''");
    add("issued_logs", "last_printed_at", "TEXT DEFAULT ''");
    add("issued_logs", "campus_code_used", "TEXT DEFAULT ''");
    add("issued_logs", "last_print_code", "TEXT DEFAULT ''");
    add("approval_requests", "last_print_code", "TEXT DEFAULT ''");
    add("print_logs", "page_no", "TEXT DEFAULT 'Page 1 of 1'");
    add("print_logs", "print_token", "TEXT DEFAULT ''");
    add("print_logs", "print_security_code", "TEXT DEFAULT ''");
    db.exec(
      "UPDATE issued_logs SET issued_year = CAST(substr(issued_at, 1, 4) AS INTEGER) WHERE (issued_year IS NULL OR issued_year = 0) AND length(issued_at) >= 4",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_issued_logs_year ON issued_logs(issued_year DESC, issued_at DESC)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_print_logs_serial ON print_logs(serial_no, copy_number DESC)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_print_logs_code ON print_logs(print_security_code)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_students_search ON students(status, class_name, full_name)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_requests_created ON approval_requests(created_at DESC, status)",
    );
    if (!db.prepare("SELECT 1 FROM admin_users").get()) {
      const initial = "school1234";
      db.prepare(
        "INSERT INTO admin_users(username,password_hash) VALUES(?,?)",
      ).run("admin", hashPassword(initial));
      fs.writeFileSync(
        path.join(dir, "admin-credentials.txt"),
        "Username: admin\nInitial password: " +
          initial +
          "\nChange this password before entering real records.\n",
        { mode: 0o600 },
      );
    } else if (!fs.existsSync(path.join(dir, "admin-credentials.txt"))) {
      const user = db
        .prepare("SELECT password_hash FROM admin_users WHERE username=?")
        .get("admin");
      fs.writeFileSync(
        path.join(dir, "admin-credentials.txt"),
        "Username: admin\n" +
          (user && checkPassword("school1234", user.password_hash)
            ? "Initial password: school1234\nChange this password before entering real records."
            : "Existing password preserved. Passwords cannot be recovered from the database. Use your current admin password.") +
          "\n",
        { mode: 0o600 },
      );
    }
    db.prepare(
      `INSERT OR IGNORE INTO school_settings(id,school_name,school_subtitle,udise_no,whatsapp_number) VALUES(1,?,?,?,?)`,
    ).run(
      BRAND.schoolName,
      BRAND.schoolSubtitle,
      "",
      "919800000000",
    );
    const udiseRow = db
      .prepare("SELECT udise_no FROM school_settings WHERE id=1")
      .get();
    if (udiseRow && udiseRow.udise_no) {
      const normalized = String(udiseRow.udise_no)
        .replace(/^\s*UDISE\s*:\s*/i, "")
        .trim();
      if (normalized !== udiseRow.udise_no)
        db.prepare("UPDATE school_settings SET udise_no=? WHERE id=1").run(
          normalized,
        );
    }
    const staffJoinRow = db
      .prepare("SELECT staff_join_code FROM school_settings WHERE id=1")
      .get();
    if (staffJoinRow && !staffJoinRow.staff_join_code) {
      const code = "RJC-" + String(crypto.randomInt(100000, 1000000));
      db.prepare("UPDATE school_settings SET staff_join_code=? WHERE id=1").run(
        code,
      );
    }
    const verifySecretRow = db
      .prepare("SELECT verification_secret FROM school_settings WHERE id=1")
      .get();
    if (verifySecretRow && !verifySecretRow.verification_secret) {
      db.prepare("UPDATE school_settings SET verification_secret=? WHERE id=1").run(
        crypto.randomBytes(32).toString("hex"),
      );
    }
    if (db.pragma("user_version", { simple: true }) < 1) {
      const samples = [
        [
          "4501",
          "Aarav Sunil Patil",
          "Sunil Tukaram Patil",
          "8th",
          "A",
          "14/06/2013",
          "2013",
          "9822011111",
          "1234",
        ],
        [
          "4502",
          "Ananya Rajesh Deshmukh",
          "Rajesh Vasant Deshmukh",
          "10th",
          "B",
          "22/09/2011",
          "2011",
          "9822022222",
          "2345",
        ],
        [
          "4503",
          "Sai Mahesh Shinde",
          "Mahesh Shinde",
          "9th",
          "A",
          "03/02/2012",
          "2012",
          "9822033333",
          "3456",
        ],
        [
          "4504",
          "Swarali Sandeep Jadhav",
          "Sandeep Prakash Jadhav",
          "7th",
          "B",
          "19/08/2014",
          "2014",
          "9822044444",
          "4567",
        ],
        [
          "4505",
          "Vedant Nitin Pawar",
          "Nitin Dattatray Pawar",
          "6th",
          "A",
          "11/12/2015",
          "2015",
          "9822055555",
          "5678",
        ],
        [
          "4506",
          "Vedant Vivek Deoda",
          "Vivek Deoda",
          "8th",
          "A",
          "09/06/2013",
          "2013",
          "9423128313",
          "",
        ],
      ];
      for (const row of samples) {
        db.prepare(
          `INSERT OR IGNORE INTO students(gr_number,full_name,father_name,class_name,division,dob,birth_year,parent_phone,aadhaar_last4) VALUES(?,?,?,?,?,?,?,?,?)`,
        ).run(...row);
        db.prepare(
          "UPDATE students SET aadhaar_last4=? WHERE gr_number=? AND full_name=? AND (aadhaar_last4 IS NULL OR aadhaar_last4='')",
        ).run(row[8], row[0], row[1]);
      }
      const templates = [
        [
          "बोनाफाईड प्रमाणपत्र",
          "बोनाफाइड प्रमाणपत्र",
          "Bonafide Certificate",
          "<p>This is to certify that <strong>{{student_name}}</strong>, child of {{father_name}}, is a bonafide student in Class {{class_name}} / {{division}}. GR No: {{gr_number}}. Date of birth: {{dob}}.</p><p>Issued on {{issue_date}}.</p>",
          "<p>प्रमाणित करण्यात येते की <strong>{{student_name}}</strong>, पालक {{father_name}}, हा/ही इयत्ता {{class_name}}, तुकडी {{division}} मध्ये शिकत आहे. जनरल रजिस्टर क्रमांक: {{gr_number}}. जन्मतारीख: {{dob}}.</p><p>दिनांक: {{issue_date}}</p>",
          "<p>प्रमाणित किया जाता है कि <strong>{{student_name}}</strong>, अभिभावक {{father_name}}, कक्षा {{class_name}}, विभाग {{division}} में अध्ययनरत है। रजिस्टर क्रमांक: {{gr_number}}। जन्मतिथि: {{dob}}।</p><p>दिनांक: {{issue_date}}</p>",
        ],
        [
          "वर्तणूक प्रमाणपत्र",
          "चरित्र प्रमाणपत्र",
          "Character Certificate",
          "<p>This is to certify that {{student_name}}, child of {{father_name}}, Class {{class_name}} / {{division}}, GR {{gr_number}}, DOB {{dob}}, has maintained good conduct at this institution.</p><p>Issued on {{issue_date}}.</p>",
          "<p>{{student_name}}, पालक {{father_name}}, इयत्ता {{class_name}}, तुकडी {{division}}, रजिस्टर {{gr_number}}, जन्मतारीख {{dob}}, याची/हिची वर्तणूक चांगली आहे.</p><p>दिनांक: {{issue_date}}</p>",
          "<p>{{student_name}}, अभिभावक {{father_name}}, कक्षा {{class_name}}, विभाग {{division}}, रजिस्टर {{gr_number}}, जन्मतिथि {{dob}}, का आचरण अच्छा है।</p><p>दिनांक: {{issue_date}}</p>",
        ],
        [
          "शुल्क भरणा प्रमाणपत्र",
          "शुल्क भुगतान प्रमाणपत्र",
          "Fee Clearance Certificate",
          "<p>As confirmed by the school office, {{student_name}}, child of {{father_name}}, Class {{class_name}} / {{division}}, GR {{gr_number}}, DOB {{dob}}, has cleared the applicable school fees as of {{issue_date}}.</p>",
          "<p>शाळा कार्यालयाच्या पुष्टीनुसार {{student_name}}, पालक {{father_name}}, इयत्ता {{class_name}}, तुकडी {{division}}, रजिस्टर {{gr_number}}, जन्मतारीख {{dob}}, याचे/हिचे लागू शालेय शुल्क {{issue_date}} पर्यंत भरलेले आहे.</p>",
          "<p>विद्यालय कार्यालय की पुष्टि के अनुसार {{student_name}}, अभिभावक {{father_name}}, कक्षा {{class_name}}, विभाग {{division}}, रजिस्टर {{gr_number}}, जन्मतिथि {{dob}}, का लागू शुल्क {{issue_date}} तक जमा है।</p>",
        ],
      ];
      for (const t of templates) {
        const existing = db
          .prepare(
            "SELECT id FROM document_templates WHERE title_en=? OR title_en=?",
          )
          .get(
            t[2],
            t[2] === "Character Certificate"
              ? "Character & Conduct Certificate"
              : t[2],
          );
        if (existing)
          db.prepare(
            "UPDATE document_templates SET body_mr=?,body_hi=? WHERE id=?",
          ).run(t[4], t[5], existing.id);
        else
          db.prepare(
            "INSERT INTO document_templates(title_mr,title_hi,title_en,body_html,body_mr,body_hi) VALUES(?,?,?,?,?,?)",
          ).run(...t);
      }
      db.pragma("user_version = 1");
    }
    // Migration 2: real school identity. Replaces the placeholder Nashik branding
    // on databases created before the rename and adds the student from the school
    // identity card. Branding edited by an administrator is never overwritten.
    if (db.pragma("user_version", { simple: true }) < 2) {
      const branding = db
        .prepare(
          "SELECT school_name, school_subtitle FROM school_settings WHERE id=1",
        )
        .get();
      if (branding && branding.school_name === LEGACY_BRAND.schoolName) {
        db.prepare(
          "UPDATE school_settings SET school_name=?, school_subtitle=?, udise_no=? WHERE id=1",
        ).run(BRAND.schoolName, BRAND.schoolSubtitle, "");
      }
      db.prepare(
        `INSERT OR IGNORE INTO students(gr_number,full_name,father_name,class_name,division,dob,birth_year,parent_phone,aadhaar_last4,status) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        "4506",
        "Vedant Vivek Deoda",
        "Vivek Deoda",
        "8th",
        "A",
        "09/06/2013",
        "2013",
        "9423128313",
        "",
        "ACTIVE",
      );
      db.pragma("user_version = 2");
    }
    // Migration 3: Keep only Bonafide Certificate active by default for parents
    // (admins can still edit, add, or re-enable other templates anytime), and
    // backfill print_count for already-printed certificates.
    if (db.pragma("user_version", { simple: true }) < 3) {
      db.prepare(
        "UPDATE document_templates SET is_active=0 WHERE title_en IN ('Character Certificate','Character & Conduct Certificate','Fee Clearance Certificate')",
      ).run();
      db.prepare(
        "UPDATE approval_requests SET print_count=1, printer_name=COALESCE(NULLIF(printer_name,''), 'School Counter Printer') WHERE print_status='PRINTED' AND COALESCE(print_count,0)=0",
      ).run();
      db.pragma("user_version = 3");
    }
  })();
  return db;
}
module.exports = { openDatabase, hashPassword, checkPassword, BRAND, MONOGRAM };
