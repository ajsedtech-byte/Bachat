/**
 * Normalize Indian mobile numbers to 10 digits (no country code stored).
 * Accepts +91 98765 43210, 919876543210, 9876543210.
 */
function normalizePhone10India(input) {
  if (input == null) return null;
  let d = String(input).replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length !== 10) return null;
  if (!/^[6-9]/.test(d)) return null;
  return d;
}

function toE164India(phone10) {
  if (!phone10 || String(phone10).length !== 10) return null;
  return `+91${phone10}`;
}

/** Mask for UI, e.g. +91 ******3210 */
function maskPhoneIndia(phone10) {
  const p = normalizePhone10India(phone10);
  if (!p || p.length < 4) return "";
  return `+91 ******${p.slice(-4)}`;
}

module.exports = { normalizePhone10India, toE164India, maskPhoneIndia };
