const fs = require("node:fs");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const sanitize = require("sanitize-html");
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const clean = (v) =>
  sanitize(String(v || ""), {
    allowedTags: [
      "p",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "h2",
      "h3",
      "ul",
      "ol",
      "li",
      "div",
      "span",
      "table",
      "thead",
      "tbody",
      "tr",
      "td",
      "th",
    ],
    allowedAttributes: {},
  });
const normalizeUdise = (v) =>
  String(v ?? "")
    .replace(/^\s*UDISE\s*:\s*/i, "")
    .trim();
const fonts = ["devanagari", "latin"]
  .map((script) => {
    const file = path.join(
      __dirname,
      "public",
      "fonts",
      `noto-sans-devanagari-${script}-400-normal.woff2`,
    );
    return `@font-face{font-family:Noto;src:url(data:font/woff2;base64,${fs.readFileSync(file).toString("base64")}) format('woff2');${script === "latin" ? "unicode-range:U+0000-00FF;" : ""}}`;
  })
  .join("");
const css =
  fonts +
  `@page{size:A4;margin:16mm}*{box-sizing:border-box}body{margin:0;background:white;color:#17202b;font-family:Noto,Arial,sans-serif;font-size:11pt;line-height:1.85}.certificate{max-width:178mm;margin:auto;overflow-wrap:anywhere}.certificate header{text-align:center;border-bottom:2px solid #17202b;padding:0 0 5mm}.certificate header img{width:22mm;height:22mm;object-fit:contain}.certificate h1{font-size:16pt;margin:2mm 0}.certificate h2{text-align:center;font-size:15pt;margin:8mm 0;text-decoration:underline}.meta{display:flex;justify-content:space-between;font-size:9pt;margin-top:5mm}.signatures{display:grid;grid-template-columns:repeat(3,1fr);align-items:end;text-align:center;gap:4mm;margin-top:20mm;break-inside:avoid}.signatures img{max-width:40mm;max-height:24mm;object-fit:contain}.qr{margin-top:8mm;border-top:1px solid #ccc;padding-top:4mm;display:flex;align-items:center;gap:4mm;break-inside:avoid}.qr img{width:23mm;height:23mm}.qr small{font-size:8pt}.certificate p{orphans:3;widows:3}table{border-collapse:collapse;width:100%}td,th{border:1px solid #aaa;padding:2mm}`;
function renderCertificate(c) {
  const s = c.settings;
  const title = esc(c.docTitle);
  const udise = normalizeUdise(s.udise_no);
  const signature = s.signature_data
    ? `<img src="${s.signature_data}" alt="Principal signature"><div>${c.lang === "mr" ? "मुख्याध्यापक" : c.lang === "hi" ? "प्रधानाचार्य" : "Principal"}</div>`
    : "<div>________________</div><div>Principal</div>";
  const stamp = s.stamp_data
    ? `<img src="${s.stamp_data}" alt="School stamp">`
    : "";
  const positions = ["left", "center", "right"]
    .map(
      (pos) =>
        `<div>${c.sigPos === pos ? signature : ""}${c.stampPos === pos ? stamp : ""}</div>`,
    )
    .join("");
  const body = `<article class="certificate"><header>${s.logo_data ? `<img src="${s.logo_data}" alt="School logo">` : ""}<h1>${esc(s.school_name)}</h1><div>${esc(s.school_subtitle)}</div>${udise ? `<small>UDISE: ${esc(udise)}</small>` : ""}</header><div class="meta"><span>Ref: ${esc(c.serialNo)}</span><span>Date: ${esc(c.issuedAt)}</span></div><h2>${title}</h2><section>${clean(c.bodyHtml)}</section><div class="signatures">${positions}</div><footer class="qr"><img src="${c.verificationQr}" alt="Verification QR"><small>School record verification<br>${esc(c.serialNo)}<br>${esc(c.verificationUrl)}</small></footer></article>`;
  return {
    certificateBody: body,
    certificateCss: css,
    certificateHtml: `<!doctype html><html lang="${c.lang || "en"}"><meta charset="utf-8"><title>${title}</title><style>${css}</style><body>${body}</body></html>`,
  };
}
function browserPath() {
  return [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((p) => p && fs.existsSync(p));
}
let busy = 0;
async function pdf(html) {
  if (busy >= 2)
    throw Object.assign(new Error("PDF renderer busy. Try again."), {
      status: 503,
    });
  const executablePath = browserPath();
  if (!executablePath)
    throw Object.assign(
      new Error(
        "Install Chrome or Edge for offline PDF downloads, or set CHROME_PATH.",
      ),
      { status: 503 },
    );
  busy++;
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: process.platform === "linux" ? ["--no-sandbox"] : [],
    });
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (r) =>
      r.url().startsWith("data:") ? r.continue() : r.abort(),
    );
    await page.setContent(html, { waitUntil: "load", timeout: 20000 });
    await page.evaluate(() => document.fonts.ready);
    return Buffer.from(
      await page.pdf({
        format: "A4",
        printBackground: true,
        preferCSSPageSize: true,
        timeout: 20000,
      }),
    );
  } finally {
    if (browser) await browser.close();
    busy--;
  }
}
module.exports = { esc, clean, renderCertificate, pdf, browserPath, normalizeUdise };
