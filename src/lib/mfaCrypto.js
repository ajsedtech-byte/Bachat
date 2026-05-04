const crypto = require("crypto");

function mfaKey() {
  const raw = process.env.MFA_ENCRYPTION_KEY || process.env.JWT_SECRET || "";
  if (!raw) {
    throw new Error("MFA_ENCRYPTION_KEY or JWT_SECRET is required for MFA");
  }
  return crypto.scryptSync(raw, "bachat-mfa-v1", 32);
}

function encryptUtf8(plain) {
  const key = mfaKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptUtf8(b64) {
  const key = mfaKey();
  const buf = Buffer.from(String(b64 || ""), "base64");
  if (buf.length < 28) {
    throw new Error("Invalid MFA payload");
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

module.exports = { encryptUtf8, decryptUtf8 };
