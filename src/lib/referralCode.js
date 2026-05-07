const crypto = require("crypto");

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function buildCode() {
  const buf = crypto.randomBytes(6);
  let code = "";
  for (let i = 0; i < 8; i += 1) {
    code += ALPHABET[buf[i % buf.length] % ALPHABET.length];
  }
  return code;
}

/**
 * @param {import("mongoose").Model} User
 * @param {import("mongoose").Document} user
 */
async function ensureReferralCode(User, user) {
  if (user.referralCode) return user.referralCode;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const code = buildCode();
    try {
      const updated = await User.findOneAndUpdate(
        {
          _id: user._id,
          $or: [
            { referralCode: null },
            { referralCode: { $exists: false } },
            { referralCode: "" },
          ],
        },
        { $set: { referralCode: code } },
        { new: true }
      ).lean();

      if (updated && updated.referralCode) {
        user.referralCode = updated.referralCode;
        return updated.referralCode;
      }

      const fresh = await User.findById(user._id).select("referralCode").lean();
      if (fresh && fresh.referralCode) {
        user.referralCode = fresh.referralCode;
        return fresh.referralCode;
      }
    } catch (err) {
      if (err && err.code === 11000) {
        continue;
      }
      throw err;
    }
  }
  throw new Error("Could not allocate referral code");
}

module.exports = { ensureReferralCode };
