const crypto = require("crypto");

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * @param {import("mongoose").Model} User
 * @param {import("mongoose").Document} user
 */
async function ensureReferralCode(User, user) {
  if (user.referralCode) return user.referralCode;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const buf = crypto.randomBytes(6);
    let code = "";
    for (let i = 0; i < 8; i += 1) {
      code += ALPHABET[buf[i % buf.length] % ALPHABET.length];
    }
    const clash = await User.findOne({ referralCode: code });
    if (!clash) {
      user.referralCode = code;
      await user.save();
      return code;
    }
  }
  throw new Error("Could not allocate referral code");
}

module.exports = { ensureReferralCode };
