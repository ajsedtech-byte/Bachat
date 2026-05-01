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
const { formatUser, formatSeller } = require("../lib/format");
const { normalizeSellerCategories } = require("../lib/categories");

const router = express.Router();

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function signToken(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }
  return jwt.sign({ sub: String(user._id), role: user.role }, secret, { expiresIn: "7d" });
}

function withDevOtp(payload, code) {
  if (process.env.NODE_ENV === "production") {
    return payload;
  }
  return { ...payload, dev_otp: code };
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
    } = req.body || {};

    if (!email || !password || !name || !city || !region) {
      return badRequest(res, "email, password, name, city, and region are required");
    }
    if (!["buyer", "seller"].includes(role)) {
      return badRequest(res, "role must be buyer or seller");
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

    const session = await mongoose.startSession();
    try {
      let createdUser;
      await session.withTransaction(async () => {
        const [user] = await User.create(
          [
            {
              email: String(email).toLowerCase().trim(),
              passwordHash,
              name,
              phone: phone || "",
              city,
              region,
              role,
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

    const fresh = await User.findById(user._id).lean();
    const token = signToken(fresh);
    return res.json({ token, user: formatUser(fresh) });
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

    const token = signToken(user);
    return res.json({ token, user: formatUser(user) });
  } catch (err) {
    return next(err);
  }
});

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

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
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
