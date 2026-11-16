"use strict";

const DOMAIN = process.env.DUCKDNS_DOMAIN || "rjc-school";
const TOKEN = process.env.DUCKDNS_TOKEN || "01c3e7b7-a5f7-40fe-96a2-e298d6b22841";

async function update() {
  try {
    const res = await fetch(
      `https://www.duckdns.org/update?domains=${encodeURIComponent(DOMAIN)}&token=${encodeURIComponent(TOKEN)}&ip=`,
      { signal: AbortSignal.timeout(10000) }
    );
    const text = await res.text();
    const ok = text.trim() === "OK";
    console.log(`[DuckDNS] Updated ${DOMAIN}.duckdns.org: ${ok ? "SUCCESS (OK)" : "FAILED (" + text.trim() + ")"}`);
    return ok;
  } catch (err) {
    console.error(`[DuckDNS] Error updating ${DOMAIN}:`, err.message);
    return false;
  }
}

if (require.main === module) {
  update();
}

module.exports = { update };
