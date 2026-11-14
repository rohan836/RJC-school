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
  `@page{size:A4;margin:16mm}@media screen{body{padding:10mm 12mm}}*{box-sizing:border-box}body{margin:0;background:white;color:#17202b;font-family:Noto,Arial,sans-serif;font-size:11pt;line-height:1.85}.certificate{max-width:178mm;margin:auto;overflow-wrap:anywhere}.certificate header{text-align:center;border-bottom:2px solid #17202b;padding:0 0 5mm}.certificate header img{width:22mm;height:22mm;object-fit:contain}.certificate .monogram{width:22mm;height:22mm;margin:0 auto 3mm;display:grid;place-items:center;border:1.5pt solid #17202b;border-radius:3mm;font-family:Georgia,'Times New Roman',serif;font-size:13pt;font-weight:700;letter-spacing:.08em}.certificate h1{font-size:17pt;margin:2mm 0 1.5mm;letter-spacing:.02em}.certificate header div{font-size:9.5pt;line-height:1.6}.certificate header small{display:block;margin-top:1.5mm;font-size:8.5pt;letter-spacing:.06em}.certificate h2{text-align:center;font-size:15pt;margin:8mm 0;text-decoration:underline}.meta{display:flex;justify-content:space-between;font-size:9pt;margin-top:5mm}.signatures{display:grid;grid-template-columns:repeat(3,1fr);align-items:end;text-align:center;gap:4mm;margin-top:20mm;break-inside:avoid}.signatures img{max-width:40mm;max-height:24mm;object-fit:contain}.qr{margin-top:8mm;border-top:1px solid #ccc;padding-top:4mm;display:flex;align-items:center;gap:4mm;break-inside:avoid}.qr img{width:23mm;height:23mm}.qr small{font-size:8pt}.certificate p{orphans:3;widows:3}table{border-collapse:collapse;width:100%}td,th{border:1px solid #aaa;padding:2mm}`;
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
  // Letterhead emblem: the uploaded school logo, or the school monogram.
  const emblem = s.logo_data
    ? `<img src="${s.logo_data}" alt="School logo">`
    : `<div class="monogram">RJC</div>`;
  const body = `<article class="certificate"><header>${emblem}<h1>${esc(s.school_name)}</h1><div>${esc(s.school_subtitle)}</div>${udise ? `<small>UDISE: ${esc(udise)}</small>` : ""}</header><div class="meta"><span>Ref: ${esc(c.serialNo)}</span><span>Date: ${esc(c.issuedAt)}</span></div><h2>${title}</h2><section>${clean(c.bodyHtml)}</section><div class="signatures">${positions}</div><footer class="qr"><img src="${c.verificationQr}" alt="Verification QR"><small>School record verification<br>${esc(c.serialNo)}<br>${esc(c.verificationUrl)}</small></footer></article>`;
  return {
    certificateBody: body,
    certificateCss: css,
    certificateHtml: `<!doctype html><html lang="${c.lang || "en"}"><meta charset="utf-8"><title>${title}</title><style>${css}</style><body>${body}</body></html>`,
  };
}
function browserPath() {
  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "C:/Program Files";
  const programFilesX86 =
    process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)";
  return [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    path.join(programFiles, "Google/Chrome/Application/chrome.exe"),
    path.join(localAppData, "Google/Chrome/Application/chrome.exe"),
    path.join(programFilesX86, "Microsoft/Edge/Application/msedge.exe"),
    path.join(programFiles, "Microsoft/Edge/Application/msedge.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/snap/bin/chromium",
  ].find((p) => p && fs.existsSync(p));
}
function stripTags(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h1|h2|h3|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function asciiSafe(text) {
  return String(text || "")
    .replace(/[•·]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, "-")
    .replace(/[^\x20-\x7E\n]/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}
function wrapLines(text, maxChars = 76) {
  const out = [];
  for (const para of String(text || "").split("\n")) {
    const line = para.trim();
    if (!line) {
      out.push("");
      continue;
    }
    let cur = "";
    for (const word of line.split(/\s+/)) {
      if (!cur) cur = word;
      else if (cur.length + 1 + word.length <= maxChars) cur += " " + word;
      else {
        out.push(cur);
        cur = word;
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}
async function pdfFallback(html) {
  const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.11, 0.11, 0.12);
  const muted = rgb(0.42, 0.42, 0.45);
  const line = rgb(0.82, 0.82, 0.84);

  const matchTag = (re) => {
    const m = re.exec(html);
    return m ? stripTags(m[1]) : "";
  };
  const schoolName = asciiSafe(matchTag(/<header>[\s\S]*?<h1>([\s\S]*?)<\/h1>/i)) || "SCHOOL DOCUMENT";
  const subtitle = asciiSafe(matchTag(/<header>[\s\S]*?<h1>[\s\S]*?<\/h1><div>([\s\S]*?)<\/div>/i));
  const udise = asciiSafe(matchTag(/<header>[\s\S]*?<small>([\s\S]*?)<\/small>/i));
  const title = asciiSafe(matchTag(/<article class="certificate">[\s\S]*?<h2>([\s\S]*?)<\/h2>/i)) || "Certificate";
  const metaMatches = [...html.matchAll(/<div class="meta"><span>([\s\S]*?)<\/span><span>([\s\S]*?)<\/span><\/div>/gi)];
  const refText = asciiSafe(metaMatches[0]?.[1] || "");
  const dateText = asciiSafe(metaMatches[0]?.[2] || "");
  const bodyRaw = stripTags(matchTag(/<section>([\s\S]*?)<\/section>/i));
  const bodyText = asciiSafe(bodyRaw);
  const qrMatch = /<footer class="qr">[\s\S]*?src="(data:image\/png;base64,[^"]+)"[\s\S]*?<small>([\s\S]*?)<\/small>/i.exec(html);

  let y = 780;
  const drawCenter = (txt, size, useBold = false, color = ink) => {
    if (!txt) return;
    const f = useBold ? bold : font;
    const w = f.widthOfTextAtSize(txt, size);
    page.drawText(txt, { x: Math.max(48, (595.28 - w) / 2), y, size, font: f, color });
    y -= size * 1.45;
  };

  drawCenter(schoolName, 17, true);
  for (const subLine of wrapLines(subtitle, 78)) drawCenter(subLine, 9.5, false, muted);
  if (udise) drawCenter(udise, 9, false, muted);

  y -= 6;
  page.drawLine({ start: { x: 48, y }, end: { x: 547, y }, thickness: 1.2, color: ink });
  y -= 20;

  if (refText) page.drawText(refText, { x: 48, y, size: 9.5, font, color: muted });
  if (dateText) {
    const dw = font.widthOfTextAtSize(dateText, 9.5);
    page.drawText(dateText, { x: 547 - dw, y, size: 9.5, font, color: muted });
  }
  y -= 32;

  drawCenter(title, 15, true);
  y -= 14;

  const hasNonAscii = /[^\x00-\x7F]/.test(bodyRaw) || /[^\x00-\x7F]/.test(matchTag(/<article class="certificate">[\s\S]*?<h2>([\s\S]*?)<\/h2>/i));
  const lines = wrapLines(bodyText, 74);
  for (const l of lines) {
    if (y < 160) break;
    if (l) page.drawText(l, { x: 48, y, size: 11.5, font, color: ink });
    y -= 18;
  }
  if (hasNonAscii && y >= 170) {
    y -= 8;
    for (const noteLine of wrapLines("Note: Install Chrome or Microsoft Edge (or use browser Print) for full Devanagari script layout.", 78)) {
      if (y < 160) break;
      page.drawText(noteLine, { x: 48, y, size: 9, font, color: muted });
      y -= 14;
    }
  }

  const footerY = 120;
  page.drawLine({ start: { x: 48, y: footerY + 24 }, end: { x: 547, y: footerY + 24 }, thickness: 0.75, color: line });
  page.drawText("Principal", { x: 460, y: footerY + 40, size: 10, font: bold, color: ink });
  page.drawLine({ start: { x: 430, y: footerY + 54 }, end: { x: 545, y: footerY + 54 }, thickness: 0.75, color: ink });

  if (qrMatch) {
    try {
      const pngBytes = Buffer.from(qrMatch[1].split(",")[1], "base64");
      const qrImg = await doc.embedPng(pngBytes);
      page.drawImage(qrImg, { x: 48, y: footerY - 58, width: 68, height: 68 });
      const qrLines = wrapLines(asciiSafe(stripTags(qrMatch[2])), 64);
      let qy = footerY - 8;
      for (const ql of qrLines.slice(0, 4)) {
        if (ql) page.drawText(ql, { x: 126, y: qy, size: 8.5, font, color: muted });
        qy -= 12;
      }
    } catch {}
  }

  return Buffer.from(await doc.save());
}
let busy = 0;
async function pdf(html) {
  if (busy >= 2)
    throw Object.assign(new Error("PDF renderer busy. Try again."), {
      status: 503,
    });
  const executablePath = browserPath();
  if (!executablePath) return pdfFallback(html);
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
