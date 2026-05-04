const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/User");
const Seller = require("../models/Seller");
const EmailOtp = require("../models/EmailOtp");
const { sendMail } = require("../services/email");
const { generateSixDigitCode, hashOtp, verifyOtp } = require("../utils/otp");
const { requireAuth, requireRole } = require("../middleware/auth");
const { formatUser, formatSeller, maskEmail } = require("../lib/format");
const { normalizeSellerCategories } = require("../lib/categories");
const { ensureReferralCode } = require("../lib/referralCode");
const { normalizePhone10India, maskPhoneIndia } = require("../lib/phone");
const { encryptUtf8, decryptUtf8 } = require("../lib/mfaCrypto");
const { generateSecret, verifySync, generateURI } = require("otplib");

const router = express.Router();

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }
  return secret;
}

function signToken(user) {
  return jwt.sign({ sub: String(user._id), role: user.role }, jwtSecret(), { expiresIn: "7d" });
}

function signMfaPendingToken(userId) {
  return jwt.sign({ sub: String(userId), purpose: "mfa_pending" }, jwtSecret(), { expiresIn: "10m" });
}

function isTeamRole(role) {
  return role === "admin" || role === "sales";
}

/** Only include OTP in JSON when EXPOSE_DEV_OTP=1 (never in real production). */
function withDevOtp(payload, code) {
  if (process.env.EXPOSE_DEV_OTP === "1") {
    return { ...payload, dev_otp: code };
  }
  return payload;
}

router.post("/register", async (req, res, next) => {
  try {
    const {
      email,
      password,
      name,
      phone,
      city,
      region,
      role = "buyer",
      shop_name,
      category,
      categories,
      referral_code,
    } = req.body || {};

    if (!email || !password || !name || !city || !region) {
      return badRequest(res, "email, password, name, city, and region are required");
    }
    if (!["buyer", "seller"].includes(role)) {
      return badRequest(res, "role must be buyer or seller");
    }

    const phone10 = normalizePhone10India(phone);
    if (!phone10) {
      return badRequest(res, "Valid 10-digit Indian mobile number is required");
    }

    let sellerCategories = [];
    if (role === "seller") {
      sellerCategories = normalizeSellerCategories(
        Array.isArray(categories) ? categories : categories != null ? [categories] : category ? [category] : []
      );
      if (!shop_name || sellerCategories.length === 0) {
        return badRequest(res, "shop_name and at least one valid shop category are required for sellers");
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const code = generateSixDigitCode();
    const codeHash = await hashOtp(code);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    let referredById = null;
    if (referral_code) {
      const ref = await User.findOne({
        referralCode: String(referral_code).trim().toUpperCase(),
      }).lean();
      if (ref && String(ref._id)) {
        referredById = ref._id;
      }
    }

    const session = await mongoose.startSession();
    let createdUser;
    try {
      await session.withTransaction(async () => {
        const [user] = await User.create(
          [
            {
              email: String(email).toLowerCase().trim(),
              passwordHash,
              name,
              phone: phone10,
              phoneVerifiedAt: null,
              city,
              region,
              role,
              referredBy: referredById || undefined,
            },
          ],
          { session }
        );
        createdUser = user;

        if (role === "seller") {
          await Seller.create(
            [
              {
                user: user._id,
                shopName: shop_name,
                categories: sellerCategories,
                category: sellerCategories[0],
                city,
                region,
              },
            ],
            { session }
          );
        }

        await EmailOtp.create(
          [{ user: user._id, codeHash, purpose: "email_verify", expiresAt }],
          { session }
        );
      });

      await ensureReferralCode(User, createdUser);

      await sendMail({
        to: createdUser.email,
        subject: "Verify your email – Bachat",
        text: `Your verification code is: ${code}\nIt expires in 15 minutes.`,
        html: `<p>Your verification code is:</p><p style="font-size:24px;font-weight:bold">${code}</p><p>It expires in 15 minutes.</p>`,
      });

      return res.status(201).json(
        withDevOtp(
          {
            message: "Registered. Check your email for the verification code.",
            user_id: String(createdUser._id),
            email: createdUser.email,
          },
          code
        )
      );
    } finally {
      session.endSession();
    }
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: "Email already registered" });
    }
    return next(err);
  }
});

router.post("/verify-email", async (req, res, next) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !code) {
      return badRequest(res, "email and code are required");
    }

    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    if (user.emailVerifiedAt) {
      return res.json({ message: "Email already verified" });
    }

    const otp = await EmailOtp.findOne({
      user: user._id,
      purpose: "email_verify",
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });

    if (!otp) {
      return res.status(400).json({ error: "No active verification code" });
    }

    const ok = await verifyOtp(String(code), otp.codeHash);
    if (!ok) {
      return res.status(400).json({ error: "Invalid code" });
    }

    otp.consumedAt = new Date();
    await otp.save();
    user.emailVerifiedAt = new Date();
    await user.save();
    await ensureReferralCode(User, user);

    if (user.role === "delivery") {
      await User.updateOne({ _id: user._id }, { $set: { "deliveryKyc.status": "awaiting_submit" } });
    }

    const fresh = await User.findById(user._id).lean();
    const token = signToken(fresh);
    return res.json({ token, user: formatUser(fresh) });
  } catch (err) {
    return next(err);
  }
});

/** Request password reset code (email). Same generic response whether user exists. */
router.post("/forgot-password", async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return badRequest(res, "email is required");
    }
    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user || !user.emailVerifiedAt) {
      return res.json({ message: "If an account exists, a reset code was sent to its email." });
    }
    const code = generateSixDigitCode();
    const codeHash = await hashOtp(code);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await EmailOtp.deleteMany({ user: user._id, purpose: "password_reset", consumedAt: null });
    await EmailOtp.create({
      user: user._id,
      codeHash,
      purpose: "password_reset",
      expiresAt,
    });
    await sendMail({
      to: user.email,
      subject: "Reset your Bachat password",
      text: `Your password reset code is: ${code}\nIt expires in 15 minutes.\nIf you did not ask for this, ignore this email.`,
      html: `<p>Your password reset code is:</p><p style="font-size:24px;font-weight:bold">${code}</p><p>It expires in 15 minutes.</p><p style="color:#64748b;font-size:13px">If you did not request a reset, ignore this email.</p>`,
    });
    return res.json({ message: "If an account exists, a reset code was sent to its email." });
  } catch (err) {
    return next(err);
  }
});

/** Set new password using email + code from forgot-password. */
router.post("/reset-password", async (req, res, next) => {
  try {
    const { email, code, new_password } = req.body || {};
    if (!email || !code || !new_password) {
      return badRequest(res, "email, code, and new_password are required");
    }
    const pw = String(new_password);
    if (pw.length < 8) {
      return badRequest(res, "new_password must be at least 8 characters");
    }
    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user || !user.emailVerifiedAt) {
      return res.status(400).json({ error: "Invalid or expired code" });
    }
    const otp = await EmailOtp.findOne({
      user: user._id,
      purpose: "password_reset",
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });
    if (!otp) {
      return res.status(400).json({ error: "Invalid or expired code" });
    }
    const ok = await verifyOtp(String(code), otp.codeHash);
    if (!ok) {
      return res.status(400).json({ error: "Invalid or expired code" });
    }
    otp.consumedAt = new Date();
    await otp.save();
    user.passwordHash = await bcrypt.hash(pw, 10);
    await user.save();
    return res.json({ message: "Password updated. You can log in now." });
  } catch (err) {
    return next(err);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return badRequest(res, "email and password are required");
    }

    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    if (!user.emailVerifiedAt) {
      return res.status(403).json({ error: "Email not verified" });
    }

    if (isTeamRole(user.role) && user.mfaTotpEnabled) {
      return res.json({
        mfa_required: true,
        mfa_token: signMfaPendingToken(user._id),
        user: { email: user.email, role: user.role },
      });
    }

    const token = signToken(user);
    return res.json({ token, user: formatUser(user) });
  } catch (err) {
    return next(err);
  }
});

router.post("/login/mfa", async (req, res, next) => {
  try {
    const { mfa_token, code } = req.body || {};
    if (!mfa_token || !code) {
      return badRequest(res, "mfa_token and code are required");
    }
    let payload;
    try {
      payload = jwt.verify(mfa_token, jwtSecret());
    } catch {
      return res.status(400).json({ error: "Invalid or expired mfa_token" });
    }
    if (payload.purpose !== "mfa_pending" || !payload.sub) {
      return res.status(400).json({ error: "Invalid mfa_token" });
    }
    const user = await User.findById(payload.sub);
    if (!user || !isTeamRole(user.role) || !user.mfaTotpEnabled || !user.mfaTotpEnc) {
      return res.status(400).json({ error: "MFA is not active for this account" });
    }
    let secret32;
    try {
      secret32 = decryptUtf8(user.mfaTotpEnc);
    } catch {
      return res.status(500).json({ error: "MFA configuration error" });
    }
    const check = verifySync({ token: String(code).replace(/\s+/g, ""), secret: secret32 });
    if (!check || !check.valid) {
      return res.status(401).json({ error: "Invalid authenticator code" });
    }
    const fresh = await User.findById(user._id).lean();
    return res.json({ token: signToken(fresh), user: formatUser(fresh) });
  } catch (err) {
    return next(err);
  }
});

router.post(
  "/mfa/enroll/start",
  requireAuth,
  requireRole("admin", "sales"),
  async (req, res, next) => {
    try {
      const user = await User.findById(req.user.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      if (user.mfaTotpEnabled) {
        return res.status(400).json({ error: "MFA is already enabled" });
      }
      const secret = generateSecret();
      user.mfaTotpPendingEnc = encryptUtf8(secret);
      await user.save();
      const otpauth_url = generateURI({ issuer: "Bachat Ops", label: user.email, secret });
      return res.json({ otpauth_url });
    } catch (err) {
      return next(err);
    }
  }
);

router.post(
  "/mfa/enroll/confirm",
  requireAuth,
  requireRole("admin", "sales"),
  async (req, res, next) => {
    try {
      const { code } = req.body || {};
      if (!code) {
        return badRequest(res, "code is required");
      }
      const user = await User.findById(req.user.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      if (user.mfaTotpEnabled) {
        return res.status(400).json({ error: "MFA is already enabled" });
      }
      if (!user.mfaTotpPendingEnc) {
        return res.status(400).json({ error: "Start enrollment first (POST /api/auth/mfa/enroll/start)" });
      }
      let secret32;
      try {
        secret32 = decryptUtf8(user.mfaTotpPendingEnc);
      } catch {
        return res.status(500).json({ error: "MFA pending secret corrupted — start again" });
      }
      const check = verifySync({ token: String(code).replace(/\s+/g, ""), secret: secret32 });
      if (!check || !check.valid) {
        return res.status(400).json({ error: "Invalid code — try again" });
      }
      user.mfaTotpEnc = user.mfaTotpPendingEnc;
      user.mfaTotpPendingEnc = "";
      user.mfaTotpEnabled = true;
      user.mfaTotpVerifiedAt = new Date();
      await user.save();
      return res.json({ message: "MFA enabled", user: formatUser(await User.findById(user._id).lean()) });
    } catch (err) {
      return next(err);
    }
  }
);

router.post(
  "/mfa/disable",
  requireAuth,
  requireRole("admin", "sales"),
  async (req, res, next) => {
    try {
      const { password, code } = req.body || {};
      if (!password) {
        return badRequest(res, "password is required");
      }
      const user = await User.findById(req.user.id);
      if (!user || !user.mfaTotpEnabled) {
        return res.status(400).json({ error: "MFA is not enabled" });
      }
      const match = await bcrypt.compare(String(password), user.passwordHash);
      if (!match) {
        return res.status(401).json({ error: "Invalid password" });
      }
      let secret32;
      try {
        secret32 = decryptUtf8(user.mfaTotpEnc);
      } catch {
        user.mfaTotpEnabled = false;
        user.mfaTotpEnc = "";
        user.mfaTotpPendingEnc = "";
        user.mfaTotpVerifiedAt = null;
        await user.save();
        return res.json({ message: "MFA disabled (secret was reset)" });
      }
      if (code) {
        const check = verifySync({ token: String(code).replace(/\s+/g, ""), secret: secret32 });
        if (!check || !check.valid) {
          return res.status(400).json({ error: "Invalid authenticator code" });
        }
      }
      user.mfaTotpEnabled = false;
      user.mfaTotpEnc = "";
      user.mfaTotpPendingEnc = "";
      user.mfaTotpVerifiedAt = null;
      await user.save();
      return res.json({ message: "MFA disabled", user: formatUser(await User.findById(user._id).lean()) });
    } catch (err) {
      return next(err);
    }
  }
);

router.post("/resend-verification", async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return badRequest(res, "email is required");
    }
    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    if (user.emailVerifiedAt) {
      return res.json({ message: "Already verified" });
    }

    const code = generateSixDigitCode();
    const codeHash = await hashOtp(code);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await EmailOtp.create({
      user: user._id,
      codeHash,
      purpose: "email_verify",
      expiresAt,
    });

    await sendMail({
      to: user.email,
      subject: "Verify your email – Bachat",
      text: `Your verification code is: ${code}\nIt expires in 15 minutes.`,
      html: `<p>Your verification code is:</p><p style="font-size:24px;font-weight:bold">${code}</p><p>It expires in 15 minutes.</p>`,
    });

    return res.json(withDevOtp({ message: "Verification code sent" }, code));
  } catch (err) {
    return next(err);
  }
});

/**
 * Authenticated: send 6-digit OTP to the user’s email to confirm the mobile on file (no SMS).
 * Completing verify still sets `phone_verified_at` after code check.
 */
router.post("/phone-otp/request", requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    const email = String(user.email || "")
      .trim()
      .toLowerCase();
    if (!email) {
      return badRequest(res, "Your account has no email — add one in your profile");
    }
    const phone10 = normalizePhone10India(user.phone);
    if (!phone10) {
      return badRequest(res, "Add a valid 10-digit Indian mobile on your profile first");
    }
    if (user.phoneVerifiedAt) {
      return res.json({
        message: "Mobile already verified",
        phone_masked: maskPhoneIndia(phone10),
        email_masked: maskEmail(email),
      });
    }

    const code = generateSixDigitCode();
    const codeHash = await hashOtp(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const phoneMasked = maskPhoneIndia(phone10);

    try {
      await sendMail({
        to: email,
        subject: "Confirm your mobile number — Bachat",
        text: `Your Bachat code to confirm mobile ${phoneMasked} is: ${code}\nIt expires in 10 minutes.\nIf you did not request this, ignore this email.`,
        html: `<p>Use this code to confirm the mobile <strong>${phoneMasked}</strong> on your Bachat account:</p><p style="font-size:24px;font-weight:bold">${code}</p><p>It expires in 10 minutes.</p><p style="color:#64748b;font-size:13px">If you did not request this, you can ignore this email.</p>`,
      });
    } catch (mailErr) {
      return res.status(502).json({ error: mailErr.message || "Could not send email" });
    }

    await EmailOtp.create({
      user: user._id,
      codeHash,
      purpose: "phone_verify",
      phone: phone10,
      expiresAt,
    });

    return res.json({
      message: "Verification code sent to your email",
      phone_masked: phoneMasked,
      email_masked: maskEmail(email),
    });
  } catch (err) {
    return next(err);
  }
});

/** Authenticated: confirm mobile OTP and set phone_verified_at. */
router.post("/phone-otp/verify", requireAuth, async (req, res, next) => {
  try {
    const { code } = req.body || {};
    if (!code) {
      return badRequest(res, "code is required");
    }
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    const phone10 = normalizePhone10India(user.phone);
    if (!phone10) {
      return badRequest(res, "No valid mobile on file");
    }
    if (user.phoneVerifiedAt) {
      const fresh = await User.findById(user._id).lean();
      return res.json({
        message: "Already verified",
        token: signToken(fresh),
        user: formatUser(fresh),
      });
    }

    const otp = await EmailOtp.findOne({
      user: user._id,
      purpose: "phone_verify",
      phone: phone10,
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });

    if (!otp) {
      return res.status(400).json({ error: "No active code — request a new one from your email" });
    }
    const ok = await verifyOtp(String(code), otp.codeHash);
    if (!ok) {
      return res.status(400).json({ error: "Invalid code" });
    }
    otp.consumedAt = new Date();
    await otp.save();
    user.phoneVerifiedAt = new Date();
    await user.save();
    await ensureReferralCode(User, user);

    const fresh = await User.findById(user._id).lean();
    return res.json({ token: signToken(fresh), user: formatUser(fresh) });
  } catch (err) {
    return next(err);
  }
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    await ensureReferralCode(User, user);
    let seller = null;
    if (user.role === "seller") {
      const s = await Seller.findOne({ user: user._id });
      seller = s ? formatSeller(s) : null;
    }
    return res.json({ user: formatUser(user), seller });
  } catch (err) {
    return next(err);
  }
});

router.patch("/profile", requireAuth, async (req, res, next) => {
  try {
    const { name, phone, city, region } = req.body || {};
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    if (name != null) user.name = String(name).trim() || user.name;
    if (phone != null) {
      const next = normalizePhone10India(phone);
      if (phone && !next) {
        return badRequest(res, "Invalid mobile number — use 10 digits (Indian)");
      }
      if (next && next !== normalizePhone10India(user.phone)) {
        user.phoneVerifiedAt = null;
      }
      if (next) user.phone = next;
      else if (String(phone).trim() === "") user.phone = "";
    }
    if (city != null) user.city = String(city).trim() || user.city;
    if (region != null) user.region = String(region).trim() || user.region;
    if (!user.city || !user.region) {
      return badRequest(res, "city and region are required");
    }
    await user.save();
    if (user.role === "seller") {
      const seller = await Seller.findOne({ user: user._id });
      if (seller) {
        seller.city = user.city;
        seller.region = user.region;
        await seller.save();
      }
    }
    await ensureReferralCode(User, user);
    let sellerOut = null;
    if (user.role === "seller") {
      const s = await Seller.findOne({ user: user._id });
      sellerOut = s ? formatSeller(s) : null;
    }
    return res.json({ user: formatUser(user), seller: sellerOut });
  } catch (err) {
    return next(err);
  }
});

router.get("/referral/me", requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    const code = await ensureReferralCode(User, user);
    const signups = await User.countDocuments({ referredBy: user._id });
    return res.json({ referral_code: code, signups });
  } catch (err) {
    return next(err);
  }
});

/**
 * Self-serve delivery partner signup (email OTP same flow as buyers).
 * Full UIDAI eKYC is not implemented — we store last 4 of Aadhaar + admin review (or auto-verify in dev).
 */
router.post("/delivery/register", async (req, res, next) => {
  try {
    const { email, password, name, phone, city, region } = req.body || {};
    if (!email || !password || !name || !city || !region) {
      return badRequest(res, "email, password, name, city, and region are required");
    }
    const phone10 = normalizePhone10India(phone);
    if (!phone10) {
      return badRequest(res, "Valid 10-digit Indian mobile number is required");
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const code = generateSixDigitCode();
    const codeHash = await hashOtp(code);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const session = await mongoose.startSession();
    let createdUser;
    try {
      await session.withTransaction(async () => {
        const [user] = await User.create(
          [
            {
              email: String(email).toLowerCase().trim(),
              passwordHash,
              name,
              phone: phone10,
              phoneVerifiedAt: null,
              city,
              region,
              role: "delivery",
              deliveryKyc: { status: "not_started" },
            },
          ],
          { session }
        );
        createdUser = user;
        await EmailOtp.create(
          [{ user: user._id, codeHash, purpose: "email_verify", expiresAt }],
          { session }
        );
      });
    } finally {
      session.endSession();
    }

    await sendMail({
      to: createdUser.email,
      subject: "Verify your email – Bachat delivery",
      text: `Your verification code is: ${code}\nIt expires in 15 minutes.`,
      html: `<p>Your verification code is:</p><p style="font-size:24px;font-weight:bold">${code}</p><p>It expires in 15 minutes.</p>`,
    });

    return res.status(201).json(
      withDevOtp(
        {
          message: "Registered. Check your email for the verification code.",
          user_id: String(createdUser._id),
          email: createdUser.email,
          next_step: "POST /api/auth/verify-email then complete KYC at /delivery-kyc.html",
        },
        code
      )
    );
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: "Email already registered" });
    }
    return next(err);
  }
});

router.post(
  "/delivery/kyc-submit",
  requireAuth,
  requireRole("delivery"),
  async (req, res, next) => {
    try {
      const user = await User.findById(req.user.id);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (!user.emailVerifiedAt) {
        return res.status(403).json({ error: "Verify your email first" });
      }
      if (!user.phoneVerifiedAt) {
        return res.status(403).json({ error: "Verify your mobile number first", code: "PHONE_UNVERIFIED" });
      }

      const st = user.deliveryKyc?.status || "not_started";
      const allowed = ["awaiting_submit", "rejected", "not_started"];
      if (!allowed.includes(st)) {
        return badRequest(res, "KYC already submitted or verified");
      }

      const { aadhar_last4, pan_last4, consent_aadhar_kyc } = req.body || {};
      if (consent_aadhar_kyc !== true && consent_aadhar_kyc !== "true") {
        return badRequest(res, "consent_aadhar_kyc must be true to continue");
      }
      const a4 = String(aadhar_last4 || "").replace(/\D/g, "");
      if (a4.length !== 4) {
        return badRequest(res, "aadhar_last4 must be exactly 4 digits (last 4 of Aadhaar only — never send full number)");
      }

      if (!user.deliveryKyc) user.deliveryKyc = {};
      user.deliveryKyc.aadharLast4 = a4;
      user.deliveryKyc.panLast4 = pan_last4
        ? String(pan_last4)
            .replace(/[^a-zA-Z0-9]/g, "")
            .slice(-4)
        : "";
      user.deliveryKyc.consentAcceptedAt = new Date();
      user.deliveryKyc.submittedAt = new Date();
      user.deliveryKyc.rejectedReason = "";

      const autoVerify =
        process.env.NODE_ENV !== "production" || process.env.DELIVERY_KYC_AUTO_VERIFY === "1";
      if (autoVerify) {
        user.deliveryKyc.status = "verified";
        user.deliveryKyc.verifiedAt = new Date();
      } else {
        user.deliveryKyc.status = "submitted";
      }
      await user.save();

      const fresh = await User.findById(user._id).lean();
      return res.json({
        delivery_kyc: formatUser(fresh).delivery_kyc,
        token: signToken(fresh),
        user: formatUser(fresh),
      });
    } catch (err) {
      return next(err);
    }
  }
);

router.post("/login-otp/request", async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return badRequest(res, "email is required");
    }
    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user || !user.emailVerifiedAt) {
      return res.json({ message: "If an account exists, a code was sent." });
    }
    const code = generateSixDigitCode();
    const codeHash = await hashOtp(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await EmailOtp.create({
      user: user._id,
      codeHash,
      purpose: "login_otp",
      expiresAt,
    });
    await sendMail({
      to: user.email,
      subject: "Your Bachat login code",
      text: `Your login code is: ${code}\nIt expires in 10 minutes.`,
      html: `<p>Your login code is:</p><p style="font-size:24px;font-weight:bold">${code}</p><p>It expires in 10 minutes.</p>`,
    });
    return res.json(withDevOtp({ message: "If an account exists, a code was sent." }, code));
  } catch (err) {
    return next(err);
  }
});

router.post("/login-otp/verify", async (req, res, next) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !code) {
      return badRequest(res, "email and code are required");
    }
    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user || !user.emailVerifiedAt) {
      return res.status(401).json({ error: "Invalid code" });
    }
    const otp = await EmailOtp.findOne({
      user: user._id,
      purpose: "login_otp",
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });
    if (!otp) {
      return res.status(400).json({ error: "No active code — request a new one" });
    }
    const ok = await verifyOtp(String(code), otp.codeHash);
    if (!ok) {
      return res.status(400).json({ error: "Invalid code" });
    }
    otp.consumedAt = new Date();
    await otp.save();
    const fresh = await User.findById(user._id).lean();
    if (isTeamRole(fresh.role) && fresh.mfaTotpEnabled) {
      return res.json({
        mfa_required: true,
        mfa_token: signMfaPendingToken(fresh._id),
        user: { email: fresh.email, role: fresh.role },
      });
    }
    const token = signToken(fresh);
    return res.json({ token, user: formatUser(fresh) });
  } catch (err) {
    return next(err);
  }
});

router.patch(
  "/seller/categories",
  requireAuth,
  requireRole("seller"),
  async (req, res, next) => {
    try {
      const { categories } = req.body || {};
      const nextCats = normalizeSellerCategories(
        Array.isArray(categories) ? categories : categories != null ? [categories] : []
      );
      if (nextCats.length === 0) {
        return badRequest(res, "Select at least one category");
      }
      const seller = await Seller.findOne({ user: req.user.id });
      if (!seller) {
        return res.status(404).json({ error: "Seller profile not found" });
      }
      seller.categories = nextCats;
      seller.category = nextCats[0];
      await seller.save();
      return res.json({ seller: formatSeller(seller) });
    } catch (err) {
      return next(err);
    }
  }
);

module.exports = router;
