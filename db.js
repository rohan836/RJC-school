const Database = require("better-sqlite3");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
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
 CREATE TABLE IF NOT EXISTS webhook_receipts(id TEXT PRIMARY KEY, status TEXT NOT NULL, serial_no TEXT, updated_at INTEGER NOT NULL);`);
  const add = (table, name, type) => {
    if (!db.pragma(`table_info(${table})`).some((c) => c.name === name))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  };
  db.transaction(() => {
    add("students", "aadhaar_last4", "TEXT DEFAULT ''");
    add("school_settings", "wifi_ssid", "TEXT DEFAULT ''");
    add("school_settings", "wifi_password", "TEXT DEFAULT ''");
    add("school_settings", "public_url", "TEXT DEFAULT ''");
    add("document_templates", "body_mr", "TEXT DEFAULT ''");
    add("document_templates", "body_hi", "TEXT DEFAULT ''");
    add("issued_logs", "certificate_json", "TEXT");
    add("issued_logs", "download_hash", "TEXT");
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
      "SHREE VIDYA MANDIR HIGH SCHOOL, NASHIK",
      "Recognized by Govt. of Maharashtra • Marathi & Semi-English Medium",
      "27200104502",
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
  })();
  return db;
}
module.exports = { openDatabase, hashPassword, checkPassword };
