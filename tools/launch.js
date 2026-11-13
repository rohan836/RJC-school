const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const projectKey = crypto.createHash('sha256').update(root.toLowerCase()).digest('hex');
const url = 'http://localhost:3000/';
function health() { return new Promise((resolve,reject) => { const req=http.get('http://127.0.0.1:3000/api/health',res=>{let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>{try{resolve(JSON.parse(data));}catch{reject(Error('Unrecognized service on port 3000.'));}});});req.setTimeout(2000,()=>req.destroy());req.on('error',reject); }); }
function own(h) { return h.appId==='rjc-school-portal' && h.projectKey===projectKey; }
async function run() {
 let h; try { h=await health(); } catch(e) { if (!['ECONNREFUSED','ECONNRESET'].includes(e.code)) throw e; }
 if (h && !own(h)) throw Error('Port 3000 belongs to another folder or an older server. Nothing was started. Close that server first.');
 if (!h) {
  const output=fs.openSync(path.join(root,'server-output.log'),'a');
  const errors=fs.openSync(path.join(root,'server-error.log'),'a');
  const server=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',output,errors]});
  server.unref();fs.closeSync(output);fs.closeSync(errors);
  for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,200));try{h=await health();if(own(h))break;}catch{}}
  if(!h||!own(h))throw Error('RJC did not start. Check server-error.log.');
 }
 console.log('RJC: '+url+' (one server, PID '+h.pid+')');
 if(!process.argv.includes('--no-browser')) {
  const chrome=path.join(process.env.ProgramFiles||'C:/Program Files','Google/Chrome/Application/chrome.exe');
  const edge=path.join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe');
  const executable=fs.existsSync(chrome)?chrome:fs.existsSync(edge)?edge:null;
  if(!executable)throw Error('Open '+url+' in your browser. Chrome/Edge could not be located.');
  const browser=spawn(executable,['--new-window',url+'?v='+Date.now()],{detached:true,windowsHide:true,stdio:'ignore'});browser.unref();
 }
}
run().catch(e=>{console.error(e.message);process.exitCode=1;});
