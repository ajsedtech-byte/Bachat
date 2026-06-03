const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const User = require("../models/User");
const Seller = require("../models/Seller");
const EmailOtp = require("../models/EmailOtp");
const { sendMail } = require("../services/email");
const { generateSixDigitCode, hashOtp, verifyOtp } = require("../utils/otp");
const { requireAuth, requireRole } = require("../middleware/auth");
const { formatUser, formatSeller, maskEmail } = require("../lib/format");
const { normalizeSellerCategories } = require("../lib/categories");
const { normalizeIndiaRegionCity } = require("../lib/indiaLocations");
const { ensureReferralCode } = require("../lib/referralCode");
const { normalizePreciseLocation, inIndiaBounds } = require("../lib/location");
const { normalizePhone10India, maskPhoneIndia } = require("../lib/phone");
const { encryptUtf8, decryptUtf8 } = require("../lib/mfaCrypto");
const { authenticator } = require("otplib");

const router = express.Router();

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sellerRegistrationMail({ name }) {
  const safeName = escapeHtml(name || "there");
  const requiredDocs = [
    "Aadhaar",
    "PAN Card",
    "Government-issued ID",
    "Proof of Address",
    "Business Registration Document",
    "Banking Details",
  ];
  const optionalDocs = ["Shop Photo", "GST Certificate", "Udyam Document", "Other Document"];
  return {
    subject: "Bachat shop registration successful - eKYC pending",
    text:
      `Hi ${name || ""},\n\n` +
      "Your shop registration on Bachat has been completed successfully.\n\n" +
      "Your eKYC is currently pending. To activate your shop for field-sales approval, please upload the required documents from your shopkeeper dashboard.\n\n" +
      "Required documents:\n" +
      requiredDocs.map((doc) => `- ${doc}`).join("\n") +
      "\n\nOptional documents:\n" +
      optionalDocs.map((doc) => `- ${doc}`).join("\n") +
      "\n\nPlease upload whichever documents you have available. Our team will review your details and update your verification status after checking the submitted documents.\n\n" +
      "We have attached the Bachat Shopkeeper Agreement with this email. Please fill and sign the agreement, then share the completed agreement with us by replying to this email or sending it on WhatsApp at +91 9755556235.\n\n" +
      "For any queries, issues, or help with document sharing, contact Bachat support on WhatsApp at +91 9755556235 or email bachat@seekhen.com. You can also share your documents and other required details over WhatsApp.\n\n" +
      "Thank you for registering with Bachat.\n\n" +
      "Regards,\nTeam Bachat",
    html:
      `<p>Hi ${safeName},</p>` +
      "<p>Your shop registration on <strong>Bachat</strong> has been completed successfully.</p>" +
      "<p>Your eKYC is currently pending. To activate your shop for field-sales approval, please upload the required documents from your shopkeeper dashboard.</p>" +
      "<p><strong>Required documents:</strong></p>" +
      `<ol>${requiredDocs.map((doc) => `<li>${escapeHtml(doc)}</li>`).join("")}</ol>` +
      "<p><strong>Optional documents:</strong></p>" +
      `<ol start="7">${optionalDocs.map((doc) => `<li>${escapeHtml(doc)}</li>`).join("")}</ol>` +
      "<p>Please upload whichever documents you have available. Our team will review your details and update your verification status after checking the submitted documents.</p>" +
      '<p><strong>Shopkeeper Agreement attached:</strong> Please fill and sign the attached <strong>Bachat Shopkeeper Agreement</strong>, then share the completed agreement with us by replying to this email or sending it on WhatsApp at <a href="https://wa.me/919755556235">+91 9755556235</a>.</p>' +
      '<p><strong>Need help?</strong> For any queries, issues, or help with document sharing, contact Bachat support on WhatsApp at <a href="https://wa.me/919755556235">+91 9755556235</a> or email <a href="mailto:bachat@seekhen.com">bachat@seekhen.com</a>. You can also share your documents and other required details over WhatsApp.</p>' +
      "<p>Thank you for registering with Bachat.</p>" +
      "<p>Regards,<br>Team Bachat</p>",
  };
}

function shopkeeperAgreementAttachment() {
  const filePath = path.join(__dirname, "..", "..", "public", "Bachat-Shopkeeper-Agreement.pdf");
  if (!fs.existsSync(filePath)) return null;
  return {
    filename: "Bachat-Shopkeeper-Agreement.pdf",
    path: filePath,
    contentType: "application/pdf",
  };
}

function duplicateKeyPayload(err) {
  const keyPattern = err && err.keyPattern ? err.keyPattern : {};
  const keyValue = err && err.keyValue ? err.keyValue : {};
  const fields = Object.keys(keyPattern);
  const field = fields[0] || Object.keys(keyValue)[0] || "";

  if (field === "email") {
    return { error: "Email already registered", duplicate_field: field, duplicate_value: keyValue[field] || "" };
  }

  if (field) {
    const pretty = field
      .replace(/\./g, " ")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (ch) => ch.toUpperCase());
    return {
      error: `${pretty} already registered`,
      duplicate_field: field,
      duplicate_value: keyValue[field] || "",
    };
  }

  return { error: "A record with these details already exists" };
}

async function ensureReferralCodeBestEffort(User, user) {
  try {
    await ensureReferralCode(User, user);
  } catch (err) {
    console.warn(
      "Referral code allocation skipped for user",
      user && user._id ? String(user._id) : "(unknown)",
      err && err.message ? `- ${err.message}` : ""
    );
  }
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

/** Attach seller profile on login/verify responses so the client can route eKYC. */
async function jsonWithSellerToken(userDocOrLean) {
  const u = userDocOrLean;
  const token = signToken(u);
  const body = { token, user: formatUser(u) };
  if (u.role === "seller") {
    const s = await Seller.findOne({ user: u._id }).lean();
    body.seller = formatSeller(s);
  }
  return body;
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
    const normalizedPlace = normalizeIndiaRegionCity(region, city);
    const nextCity = normalizedPlace.city || String(city).trim();
    const nextRegion = normalizedPlace.region || String(region).trim();
    const normalizedEmail = String(email).toLowerCase().trim();
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

    let createdUser;
      let user = await User.findOne({ email: normalizedEmail });
      if (user) {
        if (user.emailVerifiedAt) {
          const verifiedErr = new Error("Email already registered");
          verifiedErr.status = 409;
          throw verifiedErr;
        }
        if (!["buyer", "seller"].includes(user.role)) {
          const roleErr = new Error("This email is already reserved for another account type");
          roleErr.status = 409;
          throw roleErr;
        }

        user.passwordHash = passwordHash;
        user.name = name;
        user.phone = phone10;
        user.phoneVerifiedAt = null;
        user.city = nextCity;
        user.region = nextRegion;
        user.role = role;
        user.referredBy = referredById || null;
        await user.save();
      } else {
        user = await User.create({
          email: normalizedEmail,
          passwordHash,
          name,
          phone: phone10,
          phoneVerifiedAt: null,
          city: nextCity,
          region: nextRegion,
          role,
          referredBy: referredById || undefined,
        });
      }
      createdUser = user;

      if (role === "seller") {
        await Seller.findOneAndUpdate(
          { user: user._id },
          {
            $set: {
              shopName: shop_name,
              categories: sellerCategories,
              category: sellerCategories[0],
              city: nextCity,
              region: nextRegion,
              isVerified: false,
              sellerKyc: {
                status: "awaiting_path",
                path: "",
                documents: [],
                gstNumber: "",
              },
            },
          },
          { new: true, upsert: true, setDefaultsOnInsert: true }
        );
      } else {
        await Seller.deleteOne({ user: user._id });
      }

      await EmailOtp.create({
        user: user._id,
        codeHash,
        purpose: "email_verify",
        expiresAt,
      });

      await ensureReferralCodeBestEffort(User, createdUser);

      try {
        await sendMail({
          to: createdUser.email,
          subject: "Verify your email - Bachat",
          text: `Your verification code is: ${code}\nIt expires in 15 minutes.`,
          html: `<p>Your verification code is:</p><p style="font-size:24px;font-weight:bold">${code}</p><p>It expires in 15 minutes.</p>`,
        });
      } catch (mailErr) {
        return res.status(mailErr.status || 503).json(
          withDevOtp(
            {
              error:
                "Your account was created, but we could not send the verification email right now. Please try again in a few minutes.",
              user_id: String(createdUser._id),
              email: createdUser.email,
            },
            code
          )
        );
      }

      if (role === "seller") {
        try {
          const sellerMail = sellerRegistrationMail({ name: createdUser.name });
          await sendMail({
            to: createdUser.email,
            subject: sellerMail.subject,
            text: sellerMail.text,
            html: sellerMail.html,
            attachments: [shopkeeperAgreementAttachment()].filter(Boolean),
          });
        } catch (sellerMailErr) {
          console.error("[seller-registration-kyc-mail]", sellerMailErr.message || sellerMailErr);
        }
      }

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
    }
  catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ error: err.message });
    }
    if (err.code === 11000) {
      return res.status(409).json(duplicateKeyPayload(err));
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
    await ensureReferralCodeBestEffort(User, user);

    if (user.role === "delivery") {
      await User.updateOne({ _id: user._id }, { $set: { "deliveryKyc.status": "awaiting_submit" } });
    }

    const fresh = await User.findById(user._id).lean();
    return res.json(await jsonWithSellerToken(fresh));
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

    return res.json(await jsonWithSellerToken(user));
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
    const okTotp = authenticator.verify({
      token: String(code).replace(/\s+/g, ""),
      secret: secret32,
    });
    if (!okTotp) {
      return res.status(401).json({ error: "Invalid authenticator code" });
    }
    const fresh = await User.findById(user._id).lean();
    return res.json(await jsonWithSellerToken(fresh));
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
      const secret = authenticator.generateSecret();
      user.mfaTotpPendingEnc = encryptUtf8(secret);
      await user.save();
      const otpauth_url = authenticator.keyuri(user.email, "Bachat Ops", secret);
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
      const okEnroll = authenticator.verify({
        token: String(code).replace(/\s+/g, ""),
        secret: secret32,
      });
      if (!okEnroll) {
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
        const okDisable = authenticator.verify({
          token: String(code).replace(/\s+/g, ""),
          secret: secret32,
        });
        if (!okDisable) {
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
      const body = await jsonWithSellerToken(fresh);
      body.message = "Already verified";
      return res.json(body);
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
    await ensureReferralCodeBestEffort(User, user);

    const fresh = await User.findById(user._id).lean();
    return res.json(await jsonWithSellerToken(fresh));
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
    await ensureReferralCodeBestEffort(User, user);
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
    const { name, phone, city, region, location } = req.body || {};
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
    if (city != null || region != null) {
      const normalizedPlace = normalizeIndiaRegionCity(region != null ? region : user.region, city != null ? city : user.city);
      if (city != null) {
        const nextCity = normalizedPlace.city || String(city).trim();
        if (nextCity) user.city = nextCity;
      }
      if (region != null) {
        const nextRegion = normalizedPlace.region || String(region).trim();
        if (nextRegion) user.region = nextRegion;
      }
    }
    if (location != null) {
      const loc = normalizePreciseLocation(location);
      if (loc.lat == null || loc.lng == null) {
        return badRequest(res, "location.lat and location.lng are required");
      }
      if (!inIndiaBounds(loc.lat, loc.lng)) {
        return badRequest(res, "location must be inside supported India bounds");
      }
      if (!loc.addressText) {
        return badRequest(res, "location.address_text is required");
      }
      if (!loc.consentAcceptedAt) {
        return badRequest(res, "location consent is required");
      }
      if (!loc.capturedAt) loc.capturedAt = new Date();
      user.location = loc;
    }
    if (!user.city || !user.region) {
      return badRequest(res, "city and region are required");
    }
    await user.save();
    if (user.role === "seller") {
      const seller = await Seller.findOne({ user: user._id });
      if (seller) {
        seller.city = user.city;
        seller.region = user.region;
        if (user.location) {
          seller.location = {
            addressText: user.location.addressText || "",
            landmark: user.location.landmark || "",
            pincode: user.location.pincode || "",
            lat: user.location.lat ?? null,
            lng: user.location.lng ?? null,
            accuracyM: user.location.accuracyM ?? null,
            capturedAt: user.location.capturedAt || null,
            consentAcceptedAt: user.location.consentAcceptedAt || null,
          };
        }
        await seller.save();
      }
    }
    await ensureReferralCodeBestEffort(User, user);
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

    const normalizedPlace = normalizeIndiaRegionCity(region, city);
    const nextCity = normalizedPlace.city || String(city).trim();
    const nextRegion = normalizedPlace.region || String(region).trim();
    const normalizedEmail = String(email).toLowerCase().trim();
    const passwordHash = await bcrypt.hash(password, 10);
    const code = generateSixDigitCode();
    const codeHash = await hashOtp(code);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    let createdUser;
      let user = await User.findOne({ email: normalizedEmail });
      if (user) {
        if (user.emailVerifiedAt) {
          const verifiedErr = new Error("Email already registered");
          verifiedErr.status = 409;
          throw verifiedErr;
        }
        if (user.role !== "delivery") {
          const roleErr = new Error("This email is already reserved for another account type");
          roleErr.status = 409;
          throw roleErr;
        }
        user.passwordHash = passwordHash;
        user.name = name;
        user.phone = phone10;
        user.phoneVerifiedAt = null;
        user.city = nextCity;
        user.region = nextRegion;
        if (!user.deliveryKyc) user.deliveryKyc = { status: "not_started" };
        await user.save();
      } else {
        user = await User.create({
          email: normalizedEmail,
          passwordHash,
          name,
          phone: phone10,
          phoneVerifiedAt: null,
          city: nextCity,
          region: nextRegion,
          role: "delivery",
          deliveryKyc: { status: "not_started" },
        });
      }
      createdUser = user;
      await EmailOtp.create({
        user: user._id,
        codeHash,
        purpose: "email_verify",
        expiresAt,
      });
    try {
      await sendMail({
        to: createdUser.email,
        subject: "Verify your email – Bachat delivery",
        text: `Your verification code is: ${code}\nIt expires in 15 minutes.`,
        html: `<p>Your verification code is:</p><p style="font-size:24px;font-weight:bold">${code}</p><p>It expires in 15 minutes.</p>`,
      });
    } catch (mailErr) {
      return res.status(mailErr.status || 503).json(
        withDevOtp(
          {
            error:
              "Your delivery account was created, but we could not send the verification email right now. Please try again in a few minutes.",
            user_id: String(createdUser._id),
            email: createdUser.email,
          },
          code
        )
      );
    }

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
    }
  catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ error: err.message });
    }
    if (err.code === 11000) {
      return res.status(409).json(duplicateKeyPayload(err));
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
    return res.json(await jsonWithSellerToken(fresh));
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
