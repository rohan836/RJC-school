const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createParentAuth } = require('../parent-auth');

test('OTP is one use, family verification is scoped, and guardian approval is one use', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE students(gr_number TEXT,full_name TEXT,class_name TEXT,division TEXT,parent_phone TEXT,birth_year TEXT,aadhaar_last4 TEXT,status TEXT);
    CREATE TABLE issued_logs(serial_no TEXT,certificate_json TEXT,download_hash TEXT);`);
  const insert = db.prepare('INSERT INTO students VALUES(?,?,?,?,?,?,?,?)');
  insert.run('SYN-1','Synthetic One','1','A','9800000001','2014','1111','ACTIVE');
  insert.run('SYN-2','Synthetic Two','2','A','9800000001','2015','2222','ACTIVE');
  let delivered;
  const auth = createParentAuth({ db, otpConfigured: () => true, sendOtp: async (p, c) => { delivered = { p, c }; } });
  try {
    const challenge = await auth.start('9800000001', 'en');
    assert.deepEqual(Object.keys(challenge), ['challengeId']);
    assert.equal(delivered.p, '9800000001');
    const result = auth.verifyOtp(challenge.challengeId, delivered.c);
    assert.equal(result.students.length, 2);
    assert.throws(() => auth.verifyOtp(challenge.challengeId, delivered.c));
    const family = await auth.start('9800000001', 'en');
    const restricted = auth.verifyFamily(family.challengeId, '2014', 'gr', 'SYN-1');
    assert.equal(restricted.students.length, 1);
    assert.equal(auth.getSession(restricted.sessionToken).method, 'family');
    const grant = auth.approve('SYN-2', '9800000002');
    assert.equal(auth.redeem(grant).method, 'staff');
    assert.throws(() => auth.redeem(grant));
    auth.finish(restricted.sessionToken);
    assert.equal(auth.getSession(restricted.sessionToken), null);
  } finally { auth.close(); db.close(); }
});

test('unknown numbers and delivery failure remain neutral; family lockout persists', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE students(gr_number TEXT,full_name TEXT,class_name TEXT,division TEXT,parent_phone TEXT,birth_year TEXT,aadhaar_last4 TEXT,status TEXT);
    CREATE TABLE issued_logs(serial_no TEXT,certificate_json TEXT,download_hash TEXT);`);
  db.prepare('INSERT INTO students VALUES(?,?,?,?,?,?,?,?)').run('SYN-1','Synthetic One','1','A','9800000001','2014','1111','ACTIVE');
  const auth = createParentAuth({ db, otpConfigured: () => true, sendOtp: async () => { throw Error('offline'); } });
  try {
    const known = await auth.start('9800000001', 'en'), unknown = await auth.start('9800000002', 'en');
    assert.deepEqual(Object.keys(known), Object.keys(unknown));
    for (let i = 0; i < 3; i++) assert.throws(() => auth.verifyFamily(known.challengeId, '1900', 'gr', 'SYN-1'));
    assert.throws(() => auth.verifyFamily(known.challengeId, '2014', 'gr', 'SYN-1'));
    assert.ok(db.prepare('SELECT locked_until FROM parent_auth_limits WHERE failures=3').get().locked_until > Date.now());
  } finally { auth.close(); db.close(); }
});
