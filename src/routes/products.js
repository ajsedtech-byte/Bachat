const express = require("express");
const mongoose = require("mongoose");
const Product = require("../models/Product");
const Seller = require("../models/Seller");
const User = require("../models/User");
const { requireAuth, requireRole } = require("../middleware/auth");
const { buyerDisplayPrice } = require("../lib/buyerPrice");
const { canViewShopNames, maskedShopName, publicShopKey } = require("../lib/buyerPlan");
const { CATEGORY_SET, canonicalCategory, sellerCategoryList } = require("../lib/categories");
const { requireSellerTradeUnblocked } = require("../lib/sellerKycGate");
const { publicBusinessHours } = require("../lib/shopHours");

const router = express.Router();

const ALLOWED_CATEGORIES = CATEGORY_SET;

function badRequest(res, msg) {
  return res.status(400).json({ error: msg });
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactCiRegex(value) {
  return new RegExp(`^${escapeRegExp(String(value || "").trim())}$`, "i");
}

function normText(value) {
  return String(value || "").trim().toLowerCase();
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

function cleanText(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function normalizeStockQuantity(raw) {
  if (raw === "" || raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.round(n * 1000) / 1000;
}

function productQuantityFields(doc) {
  return {
    stock_quantity: doc.stockQuantity == null ? null : doc.stockQuantity,
    stock_unit: doc.stockUnit || "",
    package_type: doc.packageType || "",
    package_size: doc.packageSize || "",
  };
}

/** Buyer catalog: marked-up price only, no sellerPrice. */
function formatCatalogProduct(doc, seller, options = {}) {
  const id = doc._id;
  const price = buyerDisplayPrice(doc.sellerPrice, id);
  const showShopNames = options.showShopNames === true;
  return {
    product_id: String(id),
    title: doc.title,
    description: doc.description,
    category: doc.category,
    images: doc.images || [],
    price,
    ...productQuantityFields(doc),
    shop_name: showShopNames ? seller?.shopName || "Shop" : maskedShopName("shop"),
    shop_name_locked: !showShopNames,
    shop_key: publicShopKey(seller),
    city: seller?.city || "",
    region: seller?.region || "",
    seller_verified: Boolean(seller?.isVerified),
    shop_photo: Array.isArray(seller?.shopImages) ? seller.shopImages[0] || "" : "",
    shop_images: Array.isArray(seller?.shopImages) ? seller.shopImages : [],
    shop_tagline: seller?.storefrontTagline || "",
    shop_menu_note: seller?.menuNote || "",
    shop_hours: publicBusinessHours(seller || {}),
  };
}

function formatCatalogShop(seller, productCount = 0, options = {}) {
  const showShopNames = options.showShopNames === true;
  const categories = sellerCategoryList(seller);
  return {
    shop_id: String(seller._id),
    shop_key: publicShopKey(seller),
    shop_name: showShopNames ? seller.shopName || "Shop" : maskedShopName("shop"),
    shop_name_locked: !showShopNames,
    city: seller.city || "",
    region: seller.region || "",
    seller_verified: Boolean(seller.isVerified),
    categories,
    category: categories[0] || seller.category || "",
    shop_photo: Array.isArray(seller.shopImages) ? seller.shopImages[0] || "" : "",
    shop_images: Array.isArray(seller.shopImages) ? seller.shopImages : [],
    shop_tagline: seller.storefrontTagline || "",
    shop_menu_note: seller.menuNote || "",
    shop_hours: publicBusinessHours(seller || {}),
    product_count: productCount,
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
    ...productQuantityFields(doc),
    is_active: doc.isActive,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  };
}

async function catalogItemsForLocation({ city, region, category, q, limit = 120, showShopNames = false }) {
  const cleanCity = String(city || "").trim();
  const cleanRegion = String(region || "").trim();
  const sellers = await Seller.find({
    city: exactCiRegex(cleanCity),
    region: exactCiRegex(cleanRegion),
  })
    .select("_id shopName city region isVerified businessHours shopImages storefrontTagline menuNote")
    .lean();
  const sellerIds = sellers.map((s) => s._id);
  if (!sellerIds.length) return [];

  const filter = { seller: { $in: sellerIds }, isActive: true };
  if (category && ALLOWED_CATEGORIES.has(category)) {
    filter.category = exactCiRegex(category);
  }
  if (q) {
    const rx = new RegExp(escapeRegExp(q), "i");
    filter.$or = [{ title: rx }, { description: rx }];
  }

  const products = await Product.find(filter)
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();
  const sellerMap = Object.fromEntries(sellers.map((s) => [String(s._id), s]));
  return products.map((p) => formatCatalogProduct(p, sellerMap[String(p.seller)], { showShopNames }));
}

async function catalogShopsForLocation({ city, region, showShopNames = false }) {
  const cleanCity = String(city || "").trim();
  const cleanRegion = String(region || "").trim();
  const sellers = await Seller.find({
    city: exactCiRegex(cleanCity),
    region: exactCiRegex(cleanRegion),
  })
    .select("_id shopName city region isVerified businessHours shopImages storefrontTagline menuNote categories category")
    .lean();
  if (!sellers.length) return [];

  const sellerIds = sellers.map((s) => s._id);
  const counts = await Product.aggregate([
    { $match: { seller: { $in: sellerIds }, isActive: true } },
    { $group: { _id: "$seller", count: { $sum: 1 } } },
  ]);
  const countMap = Object.fromEntries(counts.map((row) => [String(row._id), row.count]));
  return sellers
    .map((seller) => formatCatalogShop(seller, countMap[String(seller._id)] || 0, { showShopNames }))
    .sort((a, b) => b.product_count - a.product_count || a.shop_name.localeCompare(b.shop_name));
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

    const category = req.query.category ? canonicalCategory(req.query.category) : "";
    const q = req.query.q ? String(req.query.q).trim() : "";
    const items = await catalogItemsForLocation({ city, region, category, q, showShopNames: canViewShopNames(user) });
    return res.json({ items });
  } catch (e) {
    return next(e);
  }
});

router.get("/public-catalog", async (req, res, next) => {
  try {
    const city = String(req.query.city || "Indore").trim();
    const region = String(req.query.region || "Madhya Pradesh").trim();
    const category = req.query.category ? canonicalCategory(req.query.category) : "";
    const q = req.query.q ? String(req.query.q).trim() : "";
    if (!city || !region) {
      return badRequest(res, "Choose a city and region to browse local items.");
    }
    const items = await catalogItemsForLocation({ city, region, category, q, showShopNames: false });
    return res.json({ items });
  } catch (e) {
    return next(e);
  }
});

/** Categories local shopkeepers selected (same city/region as buyer) — for store filter pills only. */
router.get("/catalog/nearby-shops", requireAuth, requireRole("buyer", "admin"), async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).lean();
    if (!user) return res.status(404).json({ error: "User not found" });
    const city = String(user.city || "").trim();
    const region = String(user.region || "").trim();
    if (!city || !region) {
      return badRequest(res, "Set your city and region on your profile to browse local shops.");
    }
    const shops = await catalogShopsForLocation({ city, region, showShopNames: canViewShopNames(user) });
    return res.json({ shops });
  } catch (e) {
    return next(e);
  }
});

router.get("/public-shops", async (req, res, next) => {
  try {
    const city = String(req.query.city || "Indore").trim();
    const region = String(req.query.region || "Madhya Pradesh").trim();
    if (!city || !region) {
      return badRequest(res, "Choose a city and region to browse local shops.");
    }
    const shops = await catalogShopsForLocation({ city, region, showShopNames: false });
    return res.json({ shops });
  } catch (e) {
    return next(e);
  }
});
router.get("/catalog/nearby-shop-categories", requireAuth, requireRole("buyer", "admin"), async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).lean();
    if (!user) return res.status(404).json({ error: "User not found" });

    const city = String(user.city || "").trim();
    const region = String(user.region || "").trim();
    if (!city || !region) {
      return badRequest(res, "Set your city and region on your profile to browse local items.");
    }

    const sellers = await Seller.find({
      city: exactCiRegex(city),
      region: exactCiRegex(region),
    })
      .select("categories category")
      .lean();
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
    if (!seller || normText(seller.city) !== normText(city) || normText(seller.region) !== normText(region)) {
      return res.status(404).json({ error: "Not found" });
    }

    return res.json({ item: formatCatalogProduct(doc, seller, { showShopNames: false }) });
  } catch (e) {
    return next(e);
  }
});

router.get("/public-catalog/:productId", async (req, res, next) => {
  try {
    const city = String(req.query.city || "Indore").trim();
    const region = String(req.query.region || "Madhya Pradesh").trim();
    const pid = req.params.productId;
    if (!city || !region || !mongoose.isValidObjectId(pid)) return res.status(404).json({ error: "Not found" });

    const doc = await Product.findOne({ _id: pid, isActive: true }).lean();
    if (!doc) return res.status(404).json({ error: "Not found" });

    const seller = await Seller.findById(doc.seller).lean();
    if (!seller || normText(seller.city) !== normText(city) || normText(seller.region) !== normText(region)) {
      return res.status(404).json({ error: "Not found" });
    }

    return res.json({ item: formatCatalogProduct(doc, seller, { showShopNames: false }) });
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

    const { title, description, category, images, price, stock_quantity, stock_unit, package_type, package_size } =
      req.body || {};
    if (!title || !category || price == null) {
      return badRequest(res, "title, category, and price are required");
    }
    const canonical = canonicalCategory(category);
    if (!canonical || !ALLOWED_CATEGORIES.has(canonical)) {
      return badRequest(res, "Invalid category");
    }
    const sellerPrice = Number(price);
    if (!Number.isFinite(sellerPrice) || sellerPrice < 1) {
      return badRequest(res, "price must be a number ≥ 1");
    }

    const stockQuantity = normalizeStockQuantity(stock_quantity);
    if (Number.isNaN(stockQuantity)) {
      return badRequest(res, "stock quantity must be a number >= 0");
    }

    const imgs = normalizeImages(images);
    if (imgs.some((u) => u.length > 850000)) {
      return badRequest(res, "Each image is too large; use smaller files or image links.");
    }

    const doc = await Product.create({
      seller: seller._id,
      title: String(title).trim().slice(0, 200),
      description: String(description || "").slice(0, 8000),
      category: canonical,
      images: imgs,
      sellerPrice,
      stockQuantity,
      stockUnit: cleanText(stock_unit, 40),
      packageType: cleanText(package_type, 80),
      packageSize: cleanText(package_size, 80),
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

    const { title, description, category, images, price, stock_quantity, stock_unit, package_type, package_size, is_active } =
      req.body || {};
    if (title != null) doc.title = String(title).trim().slice(0, 200);
    if (description != null) doc.description = String(description).slice(0, 8000);
    if (category != null) {
      const c = canonicalCategory(category);
      if (!c || !ALLOWED_CATEGORIES.has(c)) return badRequest(res, "Invalid category");
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
    if (stock_quantity !== undefined) {
      const stockQuantity = normalizeStockQuantity(stock_quantity);
      if (Number.isNaN(stockQuantity)) {
        return badRequest(res, "stock quantity must be a number >= 0");
      }
      doc.stockQuantity = stockQuantity;
    }
    if (stock_unit !== undefined) doc.stockUnit = cleanText(stock_unit, 40);
    if (package_type !== undefined) doc.packageType = cleanText(package_type, 80);
    if (package_size !== undefined) doc.packageSize = cleanText(package_size, 80);
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
