const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sanitize = require('sanitize-html');
const QRCode = require('qrcode');
const { parse } = require('csv-parse/sync');
const { rateLimit } = require('express-rate-limit');
const dataDir = process.env.KIOSK_DATA_DIR || __dirname;
fs.mkdirSync(dataDir, { recursive: true });
const app = express();
app.disable('x-powered-by');
const isLoopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
app.use((req, res, next) => {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) return res.status(403).json({ error: 'Invalid host' });
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return res.status(403).json({ error: 'Cross-origin request denied' });
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
});
app.use('/api', rateLimit({ windowMs: 60000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many requests. Try again in a minute.' } }));
app.use(express.json({ limit: '10mb' }));
app.use('/api', (req, res, next) => {
  if (req.method === 'POST') {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'JSON object required' });
    for (const [key, value] of Object.entries(req.body)) if (value !== null && typeof value === 'object' && key !== 'rows') return res.status(400).json({ error: 'Invalid field: ' + key });
    if (req.path === '/admin/login' && (typeof req.body.username !== 'string' || typeof req.body.password !== 'string' || req.body.password.length > 256)) return res.status(400).json({ error: 'Username and password required' });
    if (req.path === '/admin/templates' && ['title_mr','title_hi','title_en','body_html'].some(k => typeof req.body[k] !== 'string' || !req.body[k].trim())) return res.status(400).json({ error: 'All template titles and body are required' });
    for (const key of ['logo_data','signature_data','stamp_data']) if (req.body[key] && !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/=\r\n]+$/.test(req.body[key])) return res.status(400).json({ error: 'Upload PNG images only' });
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// WAL and FULL improve durability; reliable storage and backups are still required.
const db = new Database(path.join(dataDir, 'school.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE,
    password_hash TEXT
  );
  CREATE TABLE IF NOT EXISTS school_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    school_name TEXT,
    school_subtitle TEXT,
    udise_no TEXT,
    whatsapp_number TEXT,
    logo_data TEXT,
    signature_data TEXT,
    stamp_data TEXT
  );
  CREATE TABLE IF NOT EXISTS students (
    gr_number TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    father_name TEXT,
    class_name TEXT NOT NULL,
    division TEXT NOT NULL,
    dob TEXT NOT NULL,
    birth_year TEXT NOT NULL,
    parent_phone TEXT NOT NULL,
    status TEXT DEFAULT 'ACTIVE'
  );
  CREATE TABLE IF NOT EXISTS document_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title_mr TEXT NOT NULL,
    title_hi TEXT NOT NULL,
    title_en TEXT NOT NULL,
    body_html TEXT NOT NULL,
    sig_pos TEXT DEFAULT 'right',
    stamp_pos TEXT DEFAULT 'center',
    is_active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS issued_logs (
    serial_no TEXT PRIMARY KEY,
    gr_number TEXT,
    student_name TEXT,
    doc_title TEXT,
    verified_phone TEXT,
    is_guardian INTEGER DEFAULT 0,
    issued_at TEXT
  );
`);

// Helper: Secure Password Hashing
function hashPassword(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pwd, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pwd, stored) {
  const [salt, key] = stored.split(':');
  const hash = crypto.scryptSync(pwd, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(hash, 'hex'));
}

// Seed Initial Admin, School Branding, Templates & Sample Students
if (!db.prepare('SELECT id FROM admin_users').get()) {
  const initialPassword = 'school1234';
  db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run('admin', hashPassword(initialPassword));
}
if (!db.prepare('SELECT id FROM school_settings').get()) {
  db.prepare(`INSERT INTO school_settings (id, school_name, school_subtitle, udise_no, whatsapp_number)
    VALUES (1, 'SHREE VIDYA MANDIR HIGH SCHOOL, NASHIK', 'Recognized by Govt. of Maharashtra • Marathi & Semi-English Medium', 'UDISE: 27200104502', '919800000000')`).run();
}
if (!db.prepare('SELECT id FROM document_templates').get()) {
  const insertTpl = db.prepare(`INSERT INTO document_templates (title_mr, title_hi, title_en, body_html, sig_pos, stamp_pos) VALUES (?, ?, ?, ?, ?, ?)`);
  insertTpl.run(
    'बोनाफाईड प्रमाणपत्र (Bonafide)',
    'बोनाफाइड प्रमाणपत्र (Bonafide)',
    'Bonafide Certificate',
    `<p>This is to certify that <strong>{{student_name}}</strong>, son/daughter of <strong>{{father_name}}</strong>, is a bonafide student of this institution studying in Class <strong>{{class_name}} - {{division}}</strong> during the current academic year.</p>
     <p>As per the School General Register (GR No. <strong>{{gr_number}}</strong>), his/her Date of Birth is <strong>{{dob}}</strong>. He/She bears a good moral character.</p>`,
    'right',
    'center'
  );
  insertTpl.run(
    'वर्तणूक प्रमाणपत्र (Character)',
    'चरित्र प्रमाणपत्र (Character)',
    'Character & Conduct Certificate',
    `<p>This is to certify that <strong>{{student_name}}</strong> (GR No. <strong>{{gr_number}}</strong>), studying in Class <strong>{{class_name}} - {{division}}</strong>, has been regular in attendance and bears an exemplary moral character and conduct during his/her stay at this school.</p>`,
    'right',
    'left'
  );
}
if (!db.prepare('SELECT gr_number FROM students').get()) {
  const insStu = db.prepare(`INSERT INTO students (gr_number, full_name, father_name, class_name, division, dob, birth_year, parent_phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  insStu.run('4501', 'Aarav Sunil Patil', 'Sunil Tukaram Patil', '8th', 'A', '14/06/2013', '2013', '9822011111');
  insStu.run('4503', 'Sai Mahesh Shinde', 'Mahesh Shinde', '9th', 'A', '03/02/2012', '2012', '9822033333');
  insStu.run('4502', 'Ananya Rajesh Deshmukh', 'Rajesh Vasant Deshmukh', '10th', 'B', '22/09/2011', '2011', '9822022222');
}

// 2. Live Rotating 60-Second Campus Code (Prevents Remote Home Misuse)
let campusState = {
  code: String(crypto.randomInt(1000, 10000)),
  expiresAt: Date.now() + 60000
};
function rotateCampusCode() {
  campusState = {
    code: String(((Number(campusState.code) - 1000 + crypto.randomInt(1, 9000)) % 9000) + 1000),
    expiresAt: Date.now() + 60000
  };
}
setInterval(() => {
  if (Date.now() >= campusState.expiresAt) rotateCampusCode();
}, 1000);

app.get('/api/campus-code', (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ error: 'School monitor only' });
  if (Date.now() >= campusState.expiresAt) rotateCampusCode();
  const settings = db.prepare('SELECT whatsapp_number FROM school_settings WHERE id = 1').get();
  res.json({
    code: campusState.code,
    secondsLeft: Math.max(1, Math.ceil((campusState.expiresAt - Date.now()) / 1000)),
    whatsappNumber: settings.whatsapp_number
  });
});

// 3. Parent Public Endpoints (Masked Privacy + Instant Verification)
app.get('/api/public-config', (req, res) => {
  const templates = db.prepare('SELECT id, title_mr, title_hi, title_en FROM document_templates WHERE is_active = 1').all();
  res.json({ templates });
});

app.post('/api/search-student', (req, res) => {
  const { mode, phone, className, query } = req.body;
  let rows = [];
  if (mode === 'phone' && phone) {
    const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
    if (cleanPhone.length !== 10) return res.json({ students: [] });
    rows = db.prepare(`SELECT gr_number, full_name, class_name, division, parent_phone FROM students WHERE parent_phone LIKE ? AND status = 'ACTIVE' LIMIT 10`).all(`%${cleanPhone}`);
  } else if (mode === 'name' && query && query.trim().length >= 2) {
    const q = `%${query.trim().replace(/[%_]/g, '')}%`;
    if (className && className !== 'ALL') {
      rows = db.prepare(`SELECT gr_number, full_name, class_name, division, parent_phone FROM students WHERE class_name = ? AND (full_name LIKE ? OR father_name LIKE ?) AND status = 'ACTIVE' LIMIT 12`).all(className, q, q);
    } else {
      rows = db.prepare(`SELECT gr_number, full_name, class_name, division, parent_phone FROM students WHERE (full_name LIKE ? OR father_name LIKE ?) AND status = 'ACTIVE' LIMIT 12`).all(q, q);
    }
  }
  // Mask phone numbers before verification
  const safeRows = rows.map(r => ({
    gr_number: r.gr_number,
    full_name: r.full_name,
    class_name: r.class_name,
    division: r.division,
    masked_phone: '******' + r.parent_phone.slice(-4)
  }));
  res.json({ students: safeRows });
});

app.post('/api/generate-document', (req, res) => {
  const { grNumber, birthYear, campusCode, templateId, isGuardian, guardianPhone, isLocalKiosk } = req.body;

  // Verify 60s Campus Code unless verified locally on the lobby PC
  if (!(isLocalKiosk === true && isLoopback(req)) && (Date.now() >= campusState.expiresAt || String(campusCode || '').trim() !== campusState.code)) {
    return res.status(403).json({ error: 'Invalid or expired Campus Code. Please check the school monitor.' });
  }

  const student = db.prepare(`SELECT * FROM students WHERE gr_number = ? AND status = 'ACTIVE'`).get(grNumber);
  if (!student) return res.status(404).json({ error: 'Student record not found.' });

  if (String(birthYear).trim() !== String(student.birth_year).trim()) {
    return res.status(401).json({ error: 'Birth Year does not match school records.' });
  }

  const template = db.prepare('SELECT * FROM document_templates WHERE id = ? AND is_active = 1').get(templateId);
  if (!template) return res.status(404).json({ error: 'Document template unavailable.' });

  const settings = db.prepare('SELECT * FROM school_settings WHERE id = 1').get();
  const yearPrefix = `SCH-${new Date().getFullYear()}-%`;
  if (db.prepare('SELECT count(*) as n FROM issued_logs WHERE serial_no LIKE ?').get(yearPrefix).n >= 90000) return res.status(409).json({ error: 'Annual serial number capacity reached.' });
  let serialNo;
  do { serialNo = `SCH-${new Date().getFullYear()}-${crypto.randomInt(10000, 100000)}`; } while (db.prepare('SELECT 1 FROM issued_logs WHERE serial_no = ?').get(serialNo));
  const issuedAt = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  if (isGuardian && !/^\d{10}$/.test(String(guardianPhone || ''))) return res.status(400).json({ error: 'Guardian mobile must contain 10 digits.' });
  const verifiedPhone = isGuardian && guardianPhone ? guardianPhone : student.parent_phone;

  // Replace template placeholders safely
  const values = { student_name: student.full_name, father_name: student.father_name, class_name: student.class_name, division: student.division, gr_number: student.gr_number, dob: student.dob, issue_date: issuedAt };
  const filledHtml = cleanHtml(template.body_html).replace(/{{(\w+)}}/g, (_, key) => escapeHtml(values[key] || ''));

  // Record audit log & immediately rotate campus code so it cannot be reused
  db.prepare(`INSERT INTO issued_logs (serial_no, gr_number, student_name, doc_title, verified_phone, is_guardian, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(serialNo, student.gr_number, student.full_name, template.title_en, verifiedPhone, isGuardian ? 1 : 0, new Date().toISOString());

  rotateCampusCode();

  res.json({
    serialNo,
    issuedAt,
    docTitle: template.title_en,
    bodyHtml: filledHtml,
    sigPos: template.sig_pos,
    stampPos: template.stamp_pos,
    settings,
    student: { full_name: student.full_name, gr_number: student.gr_number, class_name: student.class_name, division: student.division }
  });
});

// 4. Password-Protected Admin Routes
const adminTokens = new Map();
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminTokens.has(token) || adminTokens.get(token) < Date.now()) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.post('/api/admin/login', rateLimit({ windowMs: 900000, limit: 15, message: { error: 'Too many login attempts. Try later.' } }), (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid admin credentials' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  for (const [key, expiry] of adminTokens) if (expiry < Date.now()) adminTokens.delete(key);
  adminTokens.set(token, Date.now() + 1800000);
  res.json({ token });
});

app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
  db.prepare('UPDATE admin_users SET password_hash = ? WHERE username = ?').run(hashPassword(newPassword), 'admin');
  adminTokens.clear();
  res.json({ ok: true });
});

app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  res.json({
    settings: db.prepare('SELECT * FROM school_settings WHERE id = 1').get(),
    students: db.prepare('SELECT * FROM students ORDER BY class_name, full_name LIMIT 200').all(),
    templates: db.prepare('SELECT * FROM document_templates').all(),
    logs: db.prepare('SELECT * FROM issued_logs ORDER BY rowid DESC LIMIT 50').all()
  });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const { school_name, school_subtitle, udise_no, whatsapp_number, logo_data, signature_data, stamp_data } = req.body;
  db.prepare(`UPDATE school_settings SET school_name=?, school_subtitle=?, udise_no=?, whatsapp_number=?, logo_data=COALESCE(?, logo_data), signature_data=COALESCE(?, signature_data), stamp_data=COALESCE(?, stamp_data) WHERE id = 1`)
    .run(school_name, school_subtitle, udise_no, whatsapp_number, logo_data || null, signature_data || null, stamp_data || null);
  res.json({ ok: true });
});

app.post('/api/admin/students', requireAdmin, (req, res) => {
  const { gr_number, full_name, father_name, class_name, division, dob, parent_phone } = req.body;
  validateStudent(req.body);
  const birth_year = String(dob).split('/').pop().slice(-4);
  db.prepare(`INSERT OR REPLACE INTO students (gr_number, full_name, father_name, class_name, division, dob, birth_year, parent_phone, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`)
    .run(gr_number, full_name, father_name, class_name, division, dob, birth_year, parent_phone);
  res.json({ ok: true });
});

app.post('/api/admin/students/bulk', requireAdmin, (req, res) => {
  const rows = req.body.csv !== undefined ? parse(req.body.csv, { columns: true, skip_empty_lines: true, bom: true, trim: true }) : req.body.rows;
  if (!Array.isArray(rows) || rows.length > 5000) return res.status(400).json({ error: 'Provide at most 5000 rows.' });
  for (const row of rows) validateStudent(row); // Array of CSV objects
  const insert = db.prepare(`INSERT OR REPLACE INTO students (gr_number, full_name, father_name, class_name, division, dob, birth_year, parent_phone, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`);
  const tx = db.transaction((items) => {
    for (const s of items) {
      if (!s.gr_number || !s.full_name || !s.dob) continue;
      const by = String(s.dob).split('/').pop().slice(-4);
      insert.run(s.gr_number, s.full_name, s.father_name || '', s.class_name || '', s.division || '', s.dob, by, s.parent_phone || '');
    }
  });
  tx(rows || []);
  res.json({ ok: true, count: (rows || []).length });
});

app.delete('/api/admin/students/:gr', requireAdmin, (req, res) => {
  db.prepare(`UPDATE students SET status = 'INACTIVE' WHERE gr_number = ?`).run(req.params.gr);
  res.json({ ok: true });
});

app.post('/api/admin/templates', requireAdmin, (req, res) => {
  const { title_mr, title_hi, title_en, body_html, sig_pos, stamp_pos } = req.body;
  if ((sig_pos && !['left','right','none'].includes(sig_pos)) || (stamp_pos && !['left','right','center','none'].includes(stamp_pos))) return res.status(400).json({ error: 'Invalid image placement' });
  db.prepare(`INSERT INTO document_templates (title_mr, title_hi, title_en, body_html, sig_pos, stamp_pos) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(title_mr, title_hi, title_en, cleanHtml(body_html), sig_pos || 'right', stamp_pos || 'center');
  res.json({ ok: true });
});

app.delete('/api/admin/templates/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM document_templates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function cleanHtml(value) { return sanitize(String(value || ''), { allowedTags: ['p','br','strong','b','em','i','u','h2','h3','ul','ol','li','div','span','table','thead','tbody','tr','td','th'], allowedAttributes: {} }); }
function validateStudent(s) {
  for (const key of ['gr_number','full_name','class_name','division','dob','parent_phone']) if (typeof s[key] !== 'string' || !s[key].trim() || s[key].length > 200) throw new Error('Missing or invalid ' + key);
  if (!/^\d{10}$/.test(s.parent_phone)) throw new Error('Parent phone must contain 10 digits');
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.dob);
  if (!m) throw new Error('DOB must be DD/MM/YYYY');
  const d = new Date(+m[3], +m[2]-1, +m[1]);
  if (d.getFullYear() !== +m[3] || d.getMonth() !== +m[2]-1 || d.getDate() !== +m[1] || d > new Date() || +m[3] < 1900) throw new Error('Invalid birth date');
}
app.post('/api/admin/logout', requireAdmin, (req, res) => { adminTokens.delete(req.headers['x-admin-token']); res.json({ ok: true }); });
app.get('/api/health', (req, res) => res.json({ ok: true, journalMode: db.pragma('journal_mode', { simple: true }), synchronous: db.pragma('synchronous', { simple: true }) }));
app.get('/api/qr', async (req, res) => {
  const text = String(req.query.text || '');
  if (text.length > 500) return res.status(400).json({ error: 'QR text too long' });
  res.type('png').send(await QRCode.toBuffer(text, { width: 240, margin: 2 }));
});
app.get('/verify/:serial', (req, res) => {
  const log = db.prepare('SELECT serial_no, doc_title, issued_at FROM issued_logs WHERE serial_no = ?').get(req.params.serial);
  res.type('html').send('<!doctype html><meta charset="utf-8"><title>Certificate verification</title><h1>Certificate verification</h1>' + (log ? '<p>Recorded in this school database.</p><p>' + escapeHtml(log.serial_no) + ' · ' + escapeHtml(log.doc_title) + ' · ' + escapeHtml(log.issued_at) + '</p>' : '<p>No matching certificate.</p>'));
});
app.post('/api/admin/backup', requireAdmin, async (req, res) => {
  const dir = path.join(dataDir, 'backups'); fs.mkdirSync(dir, { recursive: true });
  const filename = 'school-' + Date.now() + '.db'; await db.backup(path.join(dir, filename)); res.json({ ok: true, filename });
});
app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));
app.use((err, req, res, next) => { res.status(err.status || 400).json({ error: err.status === 413 ? 'Upload too large' : 'Invalid request: ' + (err.message || 'check fields') }); });
const server = app.listen(process.env.PORT || 3000, '127.0.0.1', () => console.log('School Kiosk: http://localhost:' + (process.env.PORT || 3000) + '\nInitial admin: admin / school1234 (change after login)\nDemo students: 4501 / 2013; 4502 / 2011; 4503 / 2012'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); })); 
