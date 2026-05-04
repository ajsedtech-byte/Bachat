/**
 * GSTIN format + 15th-digit checksum (CBIC-style). Does not call the GST portal.
 * Optional registry lookup is implemented in seller routes via env (GST_REGISTRY_LOOKUP_*).
 */

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i;

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * @returns {{ ok: true, gstin: string } | { ok: false, error: string }}
 */
function validateGstinChecksum(raw) {
  const gstin = String(raw || "")
    .trim()
    .replace(/\s/g, "")
    .toUpperCase();
  if (gstin.length !== 15) {
    return { ok: false, error: "GSTIN must be 15 characters" };
  }
  if (!GSTIN_PATTERN.test(gstin)) {
    return { ok: false, error: "GSTIN format is invalid" };
  }
  const mod = 36;
  let factor = 2;
  let sum = 0;
  for (let i = gstin.length - 2; i >= 0; i -= 1) {
    const codePoint = CHARS.indexOf(gstin[i]);
    if (codePoint < 0) {
      return { ok: false, error: "GSTIN contains invalid characters" };
    }
    const digit = factor * codePoint;
    sum += Math.floor(digit / mod) + (digit % mod);
    factor = factor === 2 ? 1 : 2;
  }
  const check = (mod - (sum % mod)) % mod;
  if (gstin[14] !== CHARS[check]) {
    return { ok: false, error: "GSTIN check digit does not match (typo or invalid number)" };
  }
  return { ok: true, gstin };
}

module.exports = { validateGstinChecksum, GSTIN_PATTERN };
