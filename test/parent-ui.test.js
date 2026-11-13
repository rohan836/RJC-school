const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const { browserPath } = require('../certificate');
const { openDatabase } = require('../db');

test('parent wizard verifies a synthetic family on desktop and mobile', { timeout:60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rjc-parent-ui-'));
  const db = openDatabase(dir); db.prepare('DELETE FROM students').run();
  db.prepare("INSERT INTO students(gr_number,full_name,class_name,division,dob,birth_year,parent_phone,aadhaar_last4,status) VALUES(?,?,?,?,?,?,?,?,?)").run('SYN-1','Synthetic Student','1','A','01/01/2014','2014','9800000001','1111','ACTIVE'); db.close();
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r));
  const child = spawn(process.execPath, ['server.js'], { cwd:path.join(__dirname,'..'), env:{...process.env,PORT:String(port),HOST:'127.0.0.1',KIOSK_DATA_DIR:dir,WHATSAPP_TOKEN:'',PHONE_NUMBER_ID:'',WHATSAPP_AUTH_TEMPLATE:''}, stdio:'ignore' });
  let browser;
  try {
    const base = `http://127.0.0.1:${port}`; let ready=false;
    for (let i=0;i<100;i++) { try { if ((await fetch(base+'/api/health')).ok) { ready=true; break; } } catch {} await new Promise(r=>setTimeout(r,100)); } assert.ok(ready);
    browser = await puppeteer.launch({ executablePath:browserPath(), headless:true, args:process.platform === 'linux' ? ['--no-sandbox'] : [] });
    const page = await browser.newPage();
    for (const width of [1440,390]) {
      await page.setViewport({width,height:900}); await page.goto(base, {waitUntil:'networkidle0'});
      await page.waitForFunction(() => document.getElementById('front-code').textContent.trim().length === 4);
      if (process.env.KIOSK_QA_DIR) await page.screenshot({path:path.join(process.env.KIOSK_QA_DIR, `parent-${width}.png`),fullPage:true});
      await page.click('[data-lang="en"]'); await page.type('#parent-phone','9800000001'); await page.click('#phone-button');
      await page.waitForSelector('#step-3:not([hidden])'); await page.type('#birth-year','2014'); await page.type('#family-identifier','SYN-1'); await page.click('#family-button');
      await page.waitForSelector('#step-4:not([hidden]) .student'); await page.click('#step-4 .student'); await page.waitForSelector('#step-5:not([hidden])');
      assert.equal(await page.$eval('#guardian-option', el => el.hidden), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.click('#document-list button'); const code = await page.$eval('#front-code', el => el.textContent.trim()); await page.type('#campus-code', code); await page.click('#generate-button');
      await page.waitForSelector('#step-6:not([hidden])'); await page.click('#done-button'); await page.waitForSelector('#step-1:not([hidden])');
    }
  } finally { if (browser) await browser.close(); child.kill(); await new Promise(r=>child.once('exit',r)); fs.rmSync(dir,{recursive:true,force:true}); }
});
