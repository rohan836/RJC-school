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

test('bonafide QR phone upload, attachment download, and non-strict submission work through teacher approval', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rjc-bonafide-upload-'));
  const db = openDatabase(dir);
  const adminPassword = 'synthetic-bonafide-password';
  db.prepare("UPDATE admin_users SET password_hash=? WHERE username='admin'").run(hashPassword(adminPassword));
  db.prepare('DELETE FROM students').run();
  db.prepare("INSERT INTO students(gr_number,full_name,class_name,division,dob,birth_year,parent_phone,status) VALUES(?,?,?,?,?,?,?,?)")
    .run('BF-101', 'Riya Patil', '9th', 'A', '15/06/2012', '2012', '9822000111', 'ACTIVE');
  db.prepare("INSERT INTO teachers(slot_number, name, role, is_top_teacher, pin_hash, is_active, created_at) VALUES(1, 'Mrs. Teacher', 'Top Teacher', 1, ?, 1, ?)")
    .run(hashPassword('1234'), new Date().toISOString());
  const teacherId = db.prepare('SELECT id FROM teachers WHERE slot_number=1').get().id;
  db.close();

  const socket = net.createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', KIOSK_DATA_DIR: dir, WHATSAPP_TOKEN: '', PHONE_NUMBER_ID: '', WHATSAPP_AUTH_TEMPLATE: '' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const req = async (url, { method, body, session, admin, teacher } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (session) headers['x-parent-session'] = session;
    if (admin) headers['x-admin-token'] = admin;
    if (teacher) headers['x-teacher-token'] = teacher;
    const response = await fetch(base + url, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let data = text;
    try { data = JSON.parse(text); } catch {}
    return { status: response.status, data, headers: response.headers };
  };

  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready);

    // 1. Verify parent with birthMonth + birthYear + GR + Face proof
    const start1 = await req('/api/parent/start', { body: { phone: '9822000111' } });
    const ver1 = await req('/api/parent/family', {
      body: { challengeId: start1.data.challengeId, birthMonth: '06', birthYear: '2012', grNumber: 'BF-101' },
    });
    assert.equal(ver1.status, 200);
    const session1 = ver1.data.sessionToken;
    const studentRef1 = ver1.data.students[0].studentRef;
    await req('/api/parent/face-proof', { session: session1, body: { photoData: tinyFacePng() } });
    const stData = await req('/api/parent/students', { session: session1 });
    const bonafideTpl = stData.data.templates.find((t) => /bonafide/i.test(t.title_en));
    assert.ok(bonafideTpl);

    // 2. Create QR upload session
    const upSess = await req('/api/parent/upload-session', { session: session1, body: { studentRef: studentRef1 } });
    assert.equal(upSess.status, 200);
    assert.ok(upSess.data.uploadToken);
    assert.ok(upSess.data.uploadUrl.includes('/upload/' + upSess.data.uploadToken));
    assert.ok(upSess.data.qr.startsWith('data:image/png;base64,'));

    // 3. Public phone upload page loads & bogus upload rejected
    const phonePage = await fetch(base + '/upload/' + upSess.data.uploadToken);
    assert.equal(phonePage.status, 200);
    const badPage = await fetch(base + '/upload/nonexistent-token-123');
    assert.equal(badPage.status, 410);

    const invalidUpload = await req('/api/upload/' + upSess.data.uploadToken, {
      body: { fileName: 'fake.pdf', dataUrl: 'data:application/pdf;base64,' + Buffer.from('not-a-pdf').toString('base64') },
    });
    assert.equal(invalidUpload.status, 400);

    // 4. Valid PDF upload via phone endpoint reflects in polling status & clear works
    const fakePdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    const goodUpload = await req('/api/upload/' + upSess.data.uploadToken, {
      body: { fileName: 'application-letter.pdf', dataUrl: 'data:application/pdf;base64,' + fakePdf.toString('base64') },
    });
    assert.equal(goodUpload.status, 200);
    assert.equal(goodUpload.data.fileName, 'application-letter.pdf');

    const statusRes = await req('/api/parent/upload-status/' + upSess.data.uploadToken, { session: session1 });
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.data.uploaded, true);
    assert.equal(statusRes.data.fileName, 'application-letter.pdf');

    const delRes = await req('/api/parent/upload-session/' + upSess.data.uploadToken, { method: 'DELETE', session: session1 });
    assert.equal(delRes.status, 200);
    const afterDel = await req('/api/parent/upload-status/' + upSess.data.uploadToken, { session: session1 });
    assert.equal(afterDel.data.uploaded, false);

    await req('/api/upload/' + upSess.data.uploadToken, {
      body: { fileName: 'application-proof.pdf', dataUrl: 'data:application/pdf;base64,' + fakePdf.toString('base64') },
    });

    // 5. Submit Bonafide WITH supporting document
    const code1 = await req('/api/campus-code');
    const sub1 = await req('/api/parent/submit-request', {
      session: session1,
      body: {
        studentRef: studentRef1,
        templateId: bonafideTpl.id,
        campusCode: code1.data.code,
        lang: 'en',
        uploadToken: upSess.data.uploadToken,
      },
    });
    assert.equal(sub1.status, 200);

    // 6. Submit Bonafide STRICTLY WITHOUT supporting document
    const start2 = await req('/api/parent/start', { body: { phone: '9822000111' } });
    const ver2 = await req('/api/parent/family', {
      body: { challengeId: start2.data.challengeId, birthMonth: '06', birthYear: '2012', grNumber: 'BF-101' },
    });
    const session2 = ver2.data.sessionToken;
    const studentRef2 = ver2.data.students[0].studentRef;
    await req('/api/parent/face-proof', { session: session2, body: { photoData: tinyFacePng() } });
    const code2 = await req('/api/campus-code');
    const sub2 = await req('/api/parent/submit-request', {
      session: session2,
      body: {
        studentRef: studentRef2,
        templateId: bonafideTpl.id,
        campusCode: code2.data.code,
        lang: 'en',
      },
    });
    assert.equal(sub2.status, 200);

    // 7. Teacher approves both requests -> Issued Logs show attachment + downloadable PDF/attachment
    const tLogin = await req('/api/teacher/login', { body: { teacherId, pin: '1234' } });
    const ap1 = await req('/api/teacher/requests/' + sub1.data.requestId + '/approve', { teacher: tLogin.data.token, body: {} });
    const ap2 = await req('/api/teacher/requests/' + sub2.data.requestId + '/approve', { teacher: tLogin.data.token, body: {} });
    assert.equal(ap1.status, 200);
    assert.equal(ap2.status, 200);

    const adminLogin = await req('/api/admin/login', { body: { username: 'admin', password: adminPassword } });
    const adminToken = adminLogin.data.token;
    const dash = await req('/api/admin/dashboard', { admin: adminToken });
    const log1 = dash.data.logs.find((l) => l.serial_no === ap1.data.request.serial_no);
    const log2 = dash.data.logs.find((l) => l.serial_no === ap2.data.request.serial_no);
    assert.equal(log1.supporting_doc_name, 'application-proof.pdf');
    assert.equal(log1.has_supporting_doc, 1);
    assert.equal(log1.approved_by_name, 'Mrs. Teacher');
    assert.equal(log2.has_supporting_doc, 0);

    const attRes = await fetch(base + '/api/admin/logs/' + encodeURIComponent(ap1.data.request.serial_no) + '/attachment', {
      headers: { 'x-admin-token': adminToken },
    });
    assert.equal(attRes.status, 200);
    const attBuf = Buffer.from(await attRes.arrayBuffer());
    assert.deepEqual(attBuf, fakePdf);
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
