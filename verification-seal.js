const crypto = require("node:crypto");

function canonicalCertificatePayload({
  serialNo = "",
  grNumber = "",
  studentName = "",
  docTitle = "",
  issuedAt = "",
  bodyHtml = "",
}) {
  const normalizedBody = String(bodyHtml || "")
    .replace(/\s+/g, " ")
    .trim();
  const bodyDigest = crypto
    .createHash("sha256")
    .update(normalizedBody, "utf8")
    .digest("hex");
  return [
    String(serialNo || "").trim(),
    String(grNumber || "").trim(),
    String(studentName || "").trim(),
    String(docTitle || "").trim(),
    String(issuedAt || "").trim(),
    bodyDigest,
  ].join("|");
}

function computeVerificationSeal(secret, payload) {
  const cleanSecret = String(secret || "").trim();
  if (!cleanSecret) {
    throw new Error("Verification secret is required to sign document.");
  }
  const canonical = canonicalCertificatePayload(payload || {});
  const fullMac = crypto
    .createHmac("sha256", cleanSecret)
    .update(canonical, "utf8")
    .digest("base64url");
  const sig = fullMac.slice(0, 22);
  const codeRaw = sig.replace(/[^A-Za-z0-9]/g, "X").toUpperCase().padEnd(8, "0");
  const securityCode = `RJC-${codeRaw.slice(0, 4)}-${codeRaw.slice(4, 8)}`;
  const contentHash = crypto
    .createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  return { sig, securityCode, contentHash };
}

function verifyVerificationSeal(secret, payload, suppliedSig) {
  const supplied = String(suppliedSig || "").trim();
  if (!supplied) {
    return { hasSig: false, valid: false, expected: computeVerificationSeal(secret, payload) };
  }
  const expected = computeVerificationSeal(secret, payload);
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected.sig, "utf8");
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { hasSig: true, valid, expected };
}

function computePrintCopySeal(
  secret,
  { serialNo = "", copyNumber = 1, docSignature = "" } = {},
) {
  const cleanSecret = String(secret || "").trim();
  if (!cleanSecret) {
    throw new Error("Verification secret is required to sign print copy.");
  }
  const copyNum = Math.max(1, Number(copyNumber || 1));
  const canonical = [
    "PRINT",
    String(serialNo || "").trim(),
    String(copyNum),
    String(docSignature || "").trim(),
  ].join("|");
  const printToken = crypto
    .createHmac("sha256", cleanSecret)
    .update(canonical, "utf8")
    .digest("base64url")
    .slice(0, 16);
  const hex = crypto
    .createHmac("sha256", cleanSecret)
    .update("CODE|" + canonical, "utf8")
    .digest("hex")
    .toUpperCase();
  const printSecurityCode = `PRT-${String(copyNum).padStart(2, "0")}-${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
  const pageNo = `Page 1 of 1 (Sheet #${String(copyNum).padStart(2, "0")})`;
  return { printToken, printSecurityCode, pageNo, copyNumber: copyNum };
}

function verifyPrintCopySeal(secret, payload, suppliedToken) {
  const supplied = String(suppliedToken || "").trim();
  if (!supplied) {
    return {
      hasToken: false,
      valid: false,
      expected: computePrintCopySeal(secret, payload),
    };
  }
  const expected = computePrintCopySeal(secret, payload);
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected.printToken, "utf8");
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { hasToken: true, valid, expected };
}

module.exports = {
  canonicalCertificatePayload,
  computeVerificationSeal,
  verifyVerificationSeal,
  computePrintCopySeal,
  verifyPrintCopySeal,
};

