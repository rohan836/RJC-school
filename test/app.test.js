const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

test('offline kiosk APIs, authorization, imports, safety and persistence', async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(),'school-kiosk-'));
 const port = 20000 + Math.floor(Math.random()*20000);
 const child = spawn(process.execPath,['server.js'],{env:{...process.env, PORT:String(port), KIOSK_DATA_DIR:dir},stdio:'ignore'});
 const base = `http://127.0.0.1:${port}`;
 let token = '';
 const request = async (url, method='GET', body, auth=true) => {
   const r = await fetch(base+url,{method,headers:{'content-type':'application/json',...(auth && token ? {'x-admin-token':token}:{})}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
   return {status:r.status,data:await r.json()};
 };
 try {
  let ready=false;
  for(let i=0;i<100;i++){try {if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready);
  const health=await request('/api/health'); assert.equal(health.data.journalMode,'wal'); assert.equal(health.data.synchronous,2);
  assert.equal((await request('/api/admin/dashboard')).status,401);
  assert.equal((await request('/api/admin/login','POST',{username:'admin',password:'wrong'})).status,401);
  token=(await request('/api/admin/login','POST',{username:'admin',password:'school1234'})).data.token; assert.ok(token);
  assert.equal((await request('/api/admin/dashboard')).data.students.length,3);
  const search=await request('/api/search-student','POST',{mode:'phone',phone:'9822011111'}); assert.equal(search.data.students[0].masked_phone,'******1111'); assert.equal(search.data.students[0].parent_phone,undefined);
  assert.equal((await request('/api/search-student','POST',{mode:'phone',phone:'1'})).data.students.length,0);
  assert.equal((await request('/api/search-student','POST',{mode:'name',className:'8th',query:'Aa'})).data.students.length,1);
  const config=await request('/api/public-config'); assert.equal(config.data.templates.length,2);
  const payload={grNumber:'4501',birthYear:'2013',templateId:config.data.templates[0].id};
  assert.equal((await request('/api/generate-document','POST',{...payload,campusCode:'0000'})).status,403);
  assert.equal((await request('/api/generate-document','POST',{...payload,isLocalKiosk:true,birthYear:'2000'})).status,401);
  const campus=(await request('/api/campus-code')).data;
  const doc=await request('/api/generate-document','POST',{...payload,campusCode:campus.code,isGuardian:true,guardianPhone:'9876543210'}); assert.equal(doc.status,200); assert.match(doc.data.serialNo,/^SCH-\d{4}-\d{5}$/);
  assert.notEqual((await request('/api/campus-code')).data.code,campus.code);
  assert.equal((await request('/api/generate-document','POST',{...payload,campusCode:campus.code})).status,403);
  assert.match(await (await fetch(base+'/verify/'+doc.data.serialNo)).text(),/Recorded/);
  const qr=await fetch(base+'/api/qr?text=test'); assert.equal(qr.headers.get('content-type'),'image/png'); assert.ok((await qr.arrayBuffer()).byteLength>100);
  const student={gr_number:'9999',full_name:'<img src=x onerror=alert(1)>',father_name:'Test',class_name:'8th',division:'A',dob:'01/01/2013',parent_phone:'9876543210'};
  assert.equal((await request('/api/admin/students','POST',student)).status,200);
  assert.equal((await request('/api/admin/students','POST',{...student,dob:'31/02/2013'})).status,400);
  const safe=await request('/api/generate-document','POST',{...payload,grNumber:'9999',isLocalKiosk:true}); assert.ok(!safe.data.bodyHtml.includes('<img'));
  assert.equal((await request('/api/admin/students/bulk','POST',{csv:'gr_number,full_name,father_name,class_name,division,dob,parent_phone\n8888,"Patil, Sai",Mahesh,9th,A,01/01/2012,9876543210'})).data.count,1);
  assert.equal((await request('/api/admin/students/9999','DELETE')).status,200);
  assert.equal((await request('/api/admin/settings','POST',{school_name:'Test School',school_subtitle:'Local',udise_no:'123',whatsapp_number:'919876543210'})).status,200);
  assert.equal((await request('/api/admin/settings','POST',{signature_data:'javascript:alert(1)'})).status,400);
  assert.equal((await request('/api/admin/templates','POST',{title_mr:'चाचणी',title_hi:'परीक्षण',title_en:'Test',body_html:'<script>alert(1)</script><p>{{student_name}}</p>',sig_pos:'right',stamp_pos:'center'})).status,200);
  let dashboard=(await request('/api/admin/dashboard')).data; assert.ok(!dashboard.templates.at(-1).body_html.includes('script')); assert.equal(dashboard.logs[0].gr_number,'9999');
  assert.equal((await request('/api/admin/templates/'+dashboard.templates.at(-1).id,'DELETE')).status,200);
  const backup=await request('/api/admin/backup','POST',{}); assert.equal(backup.status,200); const db=new Database(path.join(dir,'backups',backup.data.filename)); assert.equal(db.pragma('integrity_check',{simple:true}),'ok');db.close();
  assert.equal((await request('/api/admin/change-password','POST',{newPassword:'new-password-123'})).status,200);
  assert.equal((await request('/api/admin/dashboard')).status,401);
  token=(await request('/api/admin/login','POST',{username:'admin',password:'new-password-123'})).data.token;
  assert.equal((await request('/api/admin/logout','POST',{})).status,200);
  assert.equal((await request('/api/admin/dashboard')).status,401);
  assert.equal((await request('/api/unknown')).status,404);
  const html=await (await fetch(base)).text(); new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1]); assert.ok(!html.includes('api.qrserver.com'));
  assert.equal((await fetch(base+'/api/health',{headers:{origin:'https://example.com'}})).status,403);
 } finally {
  const ended=new Promise(r=>child.once('exit',r)); child.kill(); await ended;
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
