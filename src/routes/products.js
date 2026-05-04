const express = require("express");
const mongoose = require("mongoose");
const Product = require("../models/Product");
const Seller = require("../models/Seller");
const User = require("../models/User");
const { requireAuth, requireRole } = require("../middleware/auth");
const { buyerDisplayPrice } = require("../lib/buyerPrice");
const { CATEGORY_SET, sellerCategoryList } = require("../lib/categories");
const { requireSellerTradeUnblocked } = require("../lib/sellerKycGate");

const router = express.Router();

const ALLOWED_CATEGORIES = CATEGORY_SET;

function badRequest(res, msg) {
  return res.status(400).json({ error: msg });
}

async function sellerForUser(userId) {
  return Seller.findOne({ user: userId });
}

function normalizeImages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

/** Buyer catalog: marked-up price only, no sellerPrice. */
function formatCatalogProduct(doc, seller) {
  const id = doc._id;
  const price = buyerDisplayPrice(doc.sellerPrice, id);
  return {
    product_id: String(id),
    title: doc.title,
    description: doc.description,
    category: doc.category,
    images: doc.images || [],
    price,
    shop_name: seller?.shopName || "Shop",
    city: seller?.city || "",
    region: seller?.region || "",
    seller_verified: Boolean(seller?.isVerified),
  };
}

/** Seller listing: their own list price only (field name `price`). */
function formatSellerProduct(doc) {
  return {
    product_id: String(doc._id),
    title: doc.title,
    description: doc.description,
    category: doc.category,
    images: doc.images || [],
    price: doc.sellerPrice,
    is_active: doc.isActive,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  };
}

// --- Buyer catalog (same city/region as buyer account) ---
router.get("/catalog", requireAuth, requireRole("buyer", "admin"), async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).lean();
    if (!user) return res.status(404).json({ error: "User not found" });

    const city = String(user.city || "").trim();
    const region = String(user.region || "").trim();
    if (!city || !region) {
      return badRequest(res, "Set your city and region on your profile to browse local items.");
    }

    const category = req.query.category ? String(req.query.category).trim() : "";
    const q = req.query.q ? String(req.query.q).trim() : "";

    const sellers = await Seller.find({ city, region }).select("_id shopName city region").lean();
    const sellerIds = sellers.map((s) => s._id);
    if (!sellerIds.length) {
      return res.json({ items: [] });
    }

    const filter = { seller: { $in: sellerIds }, isActive: true };
    if (category && ALLOWED_CATEGORIES.has(category)) {
      filter.category = category;
    }
    if (q) {
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(esc, "i");
      filter.$or = [{ title: rx }, { description: rx }];
    }

    const products = await Product.find(filter).sort({ updatedAt: -1 }).limit(120).lean();

    const sellerMap = Object.fromEntries(sellers.map((s) => [String(s._id), s]));
    const items = products.map((p) => formatCatalogProduct(p, sellerMap[String(p.seller)]));
    return res.json({ items });
  } catch (e) {
    return next(e);
  }
});

/** Categories local shopkeepers selected (same city/region as buyer) — for store filter pills only. */
router.get("/catalog/nearby-shop-categories", requireAuth, requireRole("buyer", "admin"), async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).lean();
    if (!user) return res.status(404).json({ error: "User not found" });

    const city = String(user.city || "").trim();
    const region = String(user.region || "").trim();
    if (!city || !region) {
      return badRequest(res, "Set your city and region on your profile to browse local items.");
    }

    const sellers = await Seller.find({ city, region }).select("categories category").lean();
    const bag = new Set();
    for (const s of sellers) {
      for (const c of sellerCategoryList(s)) {
        bag.add(c);
      }
    }
    const categories = [...bag].sort((a, b) => a.localeCompare(b));
    return res.json({ categories });
  } catch (e) {
    return next(e);
  }
});

router.get("/catalog/:productId", requireAuth, requireRole("buyer", "admin"), async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).lean();
    if (!user) return res.status(404).json({ error: "User not found" });
    const city = String(user.city || "").trim();
    const region = String(user.region || "").trim();
    if (!city || !region) {
      return badRequest(res, "Set your city and region on your profile to browse local items.");
    }

    const pid = req.params.productId;
    if (!mongoose.isValidObjectId(pid)) return res.status(404).json({ error: "Not found" });

    const doc = await Product.findOne({ _id: pid, isActive: true }).lean();
    if (!doc) return res.status(404).json({ error: "Not found" });

    const seller = await Seller.findById(doc.seller).lean();
    if (!seller || seller.city !== city || seller.region !== region) {
      return res.status(404).json({ error: "Not found" });
    }

    return res.json({ item: formatCatalogProduct(doc, seller) });
  } catch (e) {
    return next(e);
  }
});

// --- Seller CRUD ---
router.get("/seller/mine", requireAuth, requireRole("seller"), async (req, res, next) => {
  try {
    const seller = await sellerForUser(req.user.id);
    if (!seller) return res.status(404).json({ error: "Seller profile not found" });

    const rows = await Product.find({ seller: seller._id })
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();

    return res.json({ items: rows.map(formatSellerProduct) });
  } catch (e) {
    return next(e);
  }
});

router.post("/", requireAuth, requireRole("seller"), requireSellerTradeUnblocked, async (req, res, next) => {
  try {
    const seller = await sellerForUser(req.user.id);
    if (!seller) return res.status(404).json({ error: "Seller profile not found" });

    const { title, description, category, images, price } = req.body || {};
    if (!title || !category || price == null) {
      return badRequest(res, "title, category, and price are required");
    }
    if (!ALLOWED_CATEGORIES.has(String(category).trim())) {
      return badRequest(res, "Invalid category");
    }
    const sellerPrice = Number(price);
    if (!Number.isFinite(sellerPrice) || sellerPrice < 1) {
      return badRequest(res, "price must be a number ≥ 1");
    }

    const imgs = normalizeImages(images);
    if (imgs.some((u) => u.length > 850000)) {
      return badRequest(res, "Each image is too large; use smaller files or image links.");
    }

    const doc = await Product.create({
      seller: seller._id,
      title: String(title).trim().slice(0, 200),
      description: String(description || "").slice(0, 8000),
      category: String(category).trim(),
      images: imgs,
      sellerPrice,
      isActive: true,
    });

    return res.status(201).json({ product: formatSellerProduct(doc.toObject()) });
  } catch (e) {
    return next(e);
  }
});

router.patch("/:productId", requireAuth, requireRole("seller"), requireSellerTradeUnblocked, async (req, res, next) => {
  try {
    const seller = await sellerForUser(req.user.id);
    if (!seller) return res.status(404).json({ error: "Seller profile not found" });

    const pid = req.params.productId;
    if (!mongoose.isValidObjectId(pid)) return res.status(404).json({ error: "Not found" });

    const doc = await Product.findOne({ _id: pid, seller: seller._id });
    if (!doc) return res.status(404).json({ error: "Not found" });

    const { title, description, category, images, price, is_active } = req.body || {};
    if (title != null) doc.title = String(title).trim().slice(0, 200);
    if (description != null) doc.description = String(description).slice(0, 8000);
    if (category != null) {
      const c = String(category).trim();
      if (!ALLOWED_CATEGORIES.has(c)) return badRequest(res, "Invalid category");
      doc.category = c;
    }
    if (images != null) {
      const imgs = normalizeImages(images);
      if (imgs.some((u) => u.length > 850000)) {
        return badRequest(res, "Each image is too large; use smaller files or image links.");
      }
      doc.images = imgs;
    }
    if (price != null) {
      const sellerPrice = Number(price);
      if (!Number.isFinite(sellerPrice) || sellerPrice < 1) {
        return badRequest(res, "price must be a number ≥ 1");
      }
      doc.sellerPrice = sellerPrice;
    }
    if (is_active != null) doc.isActive = Boolean(is_active);

    await doc.save();
    return res.json({ product: formatSellerProduct(doc.toObject()) });
  } catch (e) {
    return next(e);
  }
});

router.delete("/:productId", requireAuth, requireRole("seller"), requireSellerTradeUnblocked, async (req, res, next) => {
  try {
    const seller = await sellerForUser(req.user.id);
    if (!seller) return res.status(404).json({ error: "Seller profile not found" });

    const pid = req.params.productId;
    if (!mongoose.isValidObjectId(pid)) return res.status(404).json({ error: "Not found" });

    const doc = await Product.findOneAndUpdate(
      { _id: pid, seller: seller._id },
      { isActive: false },
      { new: true }
    ).lean();

    if (!doc) return res.status(404).json({ error: "Not found" });
    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});

module.exports = router;
