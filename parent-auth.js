const crypto = require('node:crypto');

// All capabilities are held in memory and disappear on restart. Lockouts persist.
function createParentAuth({ db, sendOtp, otpConfigured = () => false, now = Date.now }) {
  db.exec(`CREATE TABLE IF NOT EXISTS parent_auth_limits (
    subject TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0, sends INTEGER NOT NULL DEFAULT 0,
    send_window INTEGER NOT NULL DEFAULT 0, last_send INTEGER NOT NULL DEFAULT 0
  )`);
  const challenges = new Map(), sessions = new Map(), approvals = new Map();
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const token = () => crypto.randomBytes(32).toString('base64url');
  const failure = () => Object.assign(new Error('Unable to verify the details. Check them or contact the school.'), { status: 401 });
  const phone = value => /^\d{10}$/.test(String(value || '')) ? String(value) : '';
  function limit(subject) {
    db.prepare('INSERT OR IGNORE INTO parent_auth_limits(subject) VALUES(?)').run(subject);
    return db.prepare('SELECT * FROM parent_auth_limits WHERE subject=?').get(subject);
  }
  function failed(subject) {
    const row = limit(subject), current = now();
    const failures = (row.locked_until && row.locked_until <= current ? 0 : row.failures) + 1;
    db.prepare('UPDATE parent_auth_limits SET failures=?, locked_until=? WHERE subject=?')
      .run(failures, failures >= 3 ? current + 900000 : 0, subject);
  }
  function clear(subject) { db.prepare('UPDATE parent_auth_limits SET failures=0, locked_until=0 WHERE subject=?').run(subject); }
  function wipe(session) {
    if (session?.serial) db.prepare('UPDATE issued_logs SET certificate_json=NULL, download_hash=NULL WHERE serial_no=?').run(session.serial);
  }
  function getSession(id) {
    const s = sessions.get(id);
    if (!s || s.expires <= now()) { if (s) wipe(s); sessions.delete(id); return null; }
    return s;
  }
  function createSession(number, rows, method, guardianPhone = '') {
    const id = token(), refs = new Map();
    const students = rows.map(row => {
      const ref = token(); refs.set(ref, row.gr_number);
      return { studentRef: ref, full_name: row.full_name, class_name: row.class_name, division: row.division };
    });
    sessions.set(id, { phone: number, refs, method, guardianPhone, expires: now() + 900000, serial: null });
    return { sessionToken: id, method, students };
  }
  async function start(number, lang, selectedGr = null) {
    const p = phone(number);
    if (!p) throw Object.assign(new Error('Enter a valid 10-digit mobile number.'), { status: 400 });
    const begin = Date.now(), subject = digest('otp:' + p), row = limit(subject), current = now();
    const registered = !!db.prepare("SELECT 1 FROM students WHERE parent_phone=? AND status='ACTIVE' LIMIT 1").get(p);
    const window = current - row.send_window >= 900000 ? current : row.send_window;
    const count = window === current ? 0 : row.sends;
    const allowed = row.locked_until <= current && count < 5 && (!row.last_send || current - row.last_send >= 60000);
    const id = token(), code = String(crypto.randomInt(100000, 1000000));
    for (const [key, challenge] of challenges) if (challenge.subject === subject || challenge.expires <= current) challenges.delete(key);
    const challenge = { p, selectedGr, subject, hash: digest(id + ':' + code), eligible: registered && allowed && otpConfigured(), expires: current + 300000 };
    challenges.set(id, challenge);
    if (allowed) db.prepare('UPDATE parent_auth_limits SET send_window=?, sends=?, last_send=? WHERE subject=?').run(window, count + 1, current, subject);
    if (challenge.eligible) Promise.resolve().then(() => sendOtp(p, code, lang)).catch(() => { challenge.eligible = false; });
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 150 - (Date.now() - begin))));
    return { challengeId: id };
  }
  function challenge(id) {
    const c = challenges.get(String(id || ''));
    if (!c || c.expires <= now()) throw failure();
    return c;
  }
  function verifyOtp(id, code) {
    const c = challenge(id), row = limit(c.subject);
    if (row.locked_until > now()) throw failure();
    const actual = Buffer.from(digest(String(id) + ':' + String(code || '')), 'hex');
    const expected = Buffer.from(c.hash, 'hex');
    if (!crypto.timingSafeEqual(actual, expected) || !c.eligible) { failed(c.subject); throw failure(); }
    clear(c.subject); challenges.delete(id);
    const rows = db.prepare("SELECT gr_number,full_name,class_name,division FROM students WHERE parent_phone=? AND status='ACTIVE' ORDER BY full_name").all(c.p).filter(row => !c.selectedGr || row.gr_number === c.selectedGr);
    if (!rows.length) throw failure();
    return createSession(c.p, rows, 'otp');
  }
  function verifyFamily(id, year, kind, identifier) {
    const c = challenge(id), value = String(identifier || '').trim();
    const subject = digest('family:' + c.p), row = limit(subject);
    if (row.locked_until > now()) throw failure();
    const validInput = /^\d{4}$/.test(String(year || '')) && ((kind === 'gr' && value.length > 0 && value.length <= 64) || (kind === 'backup' && /^\d{4}$/.test(value)));
    let rows = [];
    if (validInput) rows = kind === 'gr'
      ? db.prepare("SELECT gr_number,full_name,class_name,division FROM students WHERE parent_phone=? AND birth_year=? AND gr_number=? AND status='ACTIVE'").all(c.p, String(year), value)
      : db.prepare("SELECT gr_number,full_name,class_name,division FROM students WHERE parent_phone=? AND birth_year=? AND aadhaar_last4=? AND status='ACTIVE'").all(c.p, String(year), value);
    rows = rows.filter(row => !c.selectedGr || row.gr_number === c.selectedGr);
    if (rows.length !== 1) { failed(subject); throw failure(); }
    clear(subject); challenges.delete(id);
    return createSession(c.p, rows, 'family');
  }
  function approve(gr, guardianPhone) {
    const p = phone(guardianPhone), student = db.prepare("SELECT gr_number FROM students WHERE gr_number=? AND status='ACTIVE'").get(String(gr || ''));
    if (!p || !student) throw Object.assign(new Error('Check the student and guardian details.'), { status: 400 });
    const id = token(); approvals.set(id, { gr: student.gr_number, p, expires: now() + 600000 }); return id;
  }
  function redeem(id) {
    const a = approvals.get(String(id || '')); approvals.delete(String(id || ''));
    if (!a || a.expires <= now()) throw failure();
    const row = db.prepare("SELECT gr_number,full_name,class_name,division,parent_phone FROM students WHERE gr_number=? AND status='ACTIVE'").get(a.gr);
    if (!row) throw failure();
    return createSession(row.parent_phone, [row], 'staff', a.p);
  }
  function finish(id) { const s = sessions.get(id); wipe(s); sessions.delete(id); }
  function issued(id, serial, downloadToken) {
    const s = getSession(id); if (!s || s.serial) throw failure();
    s.serial = serial; s.downloadHash = digest(downloadToken); s.expires = now() + 45000;
  }
  function canDownload(id, serial, downloadToken) {
    const s = getSession(id); return !!(s && s.serial === serial && s.downloadHash === digest(String(downloadToken || '')));
  }
  const timer = setInterval(() => {
    for (const id of sessions.keys()) getSession(id);
    for (const [id, c] of challenges) if (c.expires <= now()) challenges.delete(id);
    for (const [id, a] of approvals) if (a.expires <= now()) approvals.delete(id);
  }, 1000); timer.unref();
  return { start, verifyOtp, verifyFamily, getSession, approve, redeem, finish, issued, canDownload, close: () => clearInterval(timer) };
}
module.exports = { createParentAuth };
