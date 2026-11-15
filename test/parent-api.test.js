const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { PNG } = require('pngjs');
const { openDatabase, hashPassword } = require('../db');

function tinyFacePng() {
  const png = new PNG({ width: 20, height: 20 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 190; png.data[i + 1] = 140; png.data[i + 2] = 115; png.data[i + 3] = 255;
  }
  return 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');
}

test('parent APIs enforce verification, face proof, campus code, guardian scope, teacher approval and session wiping', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rjc-parent-api-'));
  const db = openDatabase(dir);
  const adminPassword = 'synthetic-test-only-password';
  db.prepare("UPDATE admin_users SET password_hash=? WHERE username='admin'").run(hashPassword(adminPassword));
  db.prepare('DELETE FROM students').run();
  db.prepare("INSERT INTO students(gr_number,full_name,class_name,division,dob,birth_year,parent_phone,aadhaar_last4,status) VALUES(?,?,?,?,?,?,?,?,?)").run('SYN-1','Synthetic One','1','A','01/01/2014','2014','9800000001','1111','ACTIVE');
  db.prepare("INSERT INTO students(gr_number,full_name,class_name,division,dob,birth_year,parent_phone,aadhaar_last4,status) VALUES(?,?,?,?,?,?,?,?,?)").run('SYN-2','Synthetic Two','2','A','01/01/2015','2015','9800000001','2222','ACTIVE');
  db.prepare("INSERT INTO teachers(slot_number, name, role, is_top_teacher, pin_hash, is_active, created_at) VALUES(1, 'Mrs. Lead', 'Top Teacher', 1, ?, 1, ?)").run(hashPassword('1234'), new Date().toISOString());
  const teacherId = db.prepare('SELECT id FROM teachers WHERE slot_number=1').get().id;
  db.close();
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', KIOSK_DATA_DIR: dir, WHATSAPP_TOKEN: '', PHONE_NUMBER_ID: '', WHATSAPP_AUTH_TEMPLATE: '' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const req = async (url, body, headers = {}) => {
    const response = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: response.status === 204 ? null : await response.json() };
  };
  try {
    let ready = false; for (let i=0;i<100;i++) { try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready);
    const config = await req('/api/public-config');
    assert.equal(config.data.classes, undefined); assert.equal(config.data.templates, undefined);
    assert.equal((await req('/api/search-student', { query:'Synthetic' })).status, 401);
    assert.equal((await req('/api/parent/submit-request', { isLocalKiosk:true, studentRef:'x' })).status, 401);
    const first = await req('/api/parent/start', { phone:'9800000001' });
    const unknown = await req('/api/parent/start', { phone:'9800000002' });
    assert.deepEqual(Object.keys(first.data), Object.keys(unknown.data));
    const verified = await req('/api/parent/family', { challengeId:first.data.challengeId, birthMonth:'01', birthYear:'2014', grNumber:'SYN-1' });
    assert.equal(verified.data.students.length, 1);
    const session = verified.data.sessionToken, studentRef = verified.data.students[0].studentRef;
    const authH = { 'x-parent-session': session };

    // Face proof required before student list or submit
    assert.equal((await req('/api/parent/students', undefined, authH)).status, 403);
    assert.equal((await req('/api/parent/face-proof', { photoData: tinyFacePng() }, authH)).status, 200);

    const students = await req('/api/parent/students', undefined, authH);
    assert.equal(students.data.students.length, 1);
    const templateId = students.data.templates[0].id;
    assert.equal((await req('/api/parent/submit-request', { studentRef, templateId, isLocalKiosk:true }, authH)).status, 403);
    const live = await req('/api/campus-code');
    assert.equal((await req('/api/parent/submit-request', { studentRef, templateId, campusCode:live.data.code, isGuardian:true, guardianPhone:'9800000002' }, authH)).status, 403);
    assert.equal((await req('/api/generate-document', { studentRef, templateId, campusCode:live.data.code }, authH)).status, 403);

    const login = await req('/api/admin/login', { username:'admin', password:adminPassword });
    const approvalResponse = await fetch(base + '/api/admin/guardian-approval', { method:'POST', headers:{ 'Content-Type':'application/json', 'x-admin-token':login.data.token }, body:JSON.stringify({ grNumber:'SYN-2', guardianPhone:'9800000002', password:adminPassword }) });
    assert.equal(approvalResponse.status, 200);
    const approval = await approvalResponse.json();
    const grant = new URL(approval.url).searchParams.get('guardian');
    const guardian = await req('/api/parent/guardian', { approval:grant });
    assert.equal(guardian.data.students.length, 1);
    assert.equal((await req('/api/parent/guardian', { approval:grant })).status, 401);
    await req('/api/parent/face-proof', { photoData: tinyFacePng() }, { 'x-parent-session': guardian.data.sessionToken });
    const badGuardian = await req('/api/parent/submit-request', { studentRef:guardian.data.students[0].studentRef, templateId, campusCode:'0000' }, { 'x-parent-session': guardian.data.sessionToken });
    assert.equal(badGuardian.status, 403);

    const issue = { studentRef, templateId, campusCode:live.data.code, lang:'en' };
    const [one, two] = await Promise.all([req('/api/parent/submit-request', issue, authH), req('/api/parent/submit-request', issue, authH)]);
    assert.deepEqual([one.status, two.status].sort(), [200, 409]);

    const newCode = await req('/api/campus-code');
    const guardianSubmit = await req('/api/parent/submit-request', { studentRef:guardian.data.students[0].studentRef, templateId, campusCode:newCode.data.code }, { 'x-parent-session': guardian.data.sessionToken });
    assert.equal(guardianSubmit.status, 200);

    const tLogin = await req('/api/teacher/login', { teacherId, pin:'1234' });
    const tApprove = await req(`/api/teacher/requests/${guardianSubmit.data.requestId}/approve`, {}, { 'x-teacher-token': tLogin.data.token });
    assert.equal(tApprove.status, 200);

    const audit = require('better-sqlite3')(path.join(dir, 'school.db'), { readonly:true });
    const gLog = audit.prepare('SELECT is_guardian, approved_by_name FROM issued_logs WHERE serial_no=?').get(tApprove.data.request.serial_no);
    assert.equal(gLog.is_guardian, 1);
    assert.equal(gLog.approved_by_name, 'Mrs. Lead');
    audit.close();

    await req('/api/parent/done', {}, authH);
    assert.equal((await req('/api/parent/students', undefined, authH)).status, 401);
    const pdf = await fetch(base + '/api/documents/' + tApprove.data.request.serial_no + '/pdf', { headers: authH });
    assert.equal(pdf.status, 401);
  } finally {
    child.kill(); await new Promise(r => child.once('exit', r));
    fs.rmSync(dir, { recursive:true, force:true });
  }
});
