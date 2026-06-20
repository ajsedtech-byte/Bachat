const express = require("express");
const mongoose = require("mongoose");
const Product = require("../models/Product");
const Seller = require("../models/Seller");
const User = require("../models/User");
const { requireAuth, requireRole } = require("../middleware/auth");
const { buyerDisplayPrice } = require("../lib/buyerPrice");
const { canViewShopNames, maskedShopName, publicShopKey } = require("../lib/buyerPlan");
const { CATEGORIES, CATEGORY_SET, canonicalCategory, sellerCategoryList } = require("../lib/categories");
const { requireSellerTradeUnblocked, sellerTradeBlocked } = require("../lib/sellerKycGate");
const { publicBusinessHours } = require("../lib/shopHours");
const { notifySellerKycPending } = require("../services/sellerKycReminder");
const { externalizeImages } = require("../lib/imageStorage");

const router = express.Router();

const ALLOWED_CATEGORIES = CATEGORY_SET;
const MENU_EXTRACT_MAX_IMAGES = 4;
const MENU_EXTRACT_MAX_IMAGE_CHARS = 1200000;

function badRequest(res, msg) {
  return res.status(400).json({ error: msg });
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactCiRegex(value) {
  return new RegExp(`^${escapeRegExp(String(value || "").trim())}$`, "i");
}

function queryLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function normText(value) {
  return String(value || "").trim().toLowerCase();
}

async function sellerForUser(userId) {
  return Seller.findOne({ user: userId });
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

function normalizeMoney(raw) {
  if (raw === "" || raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return NaN;
  return Math.round(n * 100) / 100;
}

function parseMaybeJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_e) {
      return null;
    }
  }
}

function inferMenuCategory(row, fallbackCategory) {
  const explicit = canonicalCategory(row && row.category);
  if (explicit) return explicit;
  const text = [
    row && row.category,
    row && (row.title || row.name || row.item_name),
    row && row.description,
    row && (row.package_type || row.variant),
  ].filter(Boolean).join(" ").toLowerCase();
  const rules = [
    {
      category: "Food",
      words: [
        "pizza", "burger", "momo", "momos", "noodle", "chowmein", "roll", "sandwich", "pasta", "maggi", "fries",
        "chaat", "samosa", "kachori", "poha", "idli", "dosa", "uttapam", "vada", "paneer", "thali", "biryani",
        "rice bowl", "fried rice", "manchurian", "spring roll", "paratha", "kulcha", "naan", "roti", "tikka",
      ],
    },
    { category: "Bakery & cakes", words: ["cake", "pastry", "bakery", "bread", "bun", "cookie", "cookies", "muffin", "donut"] },
    { category: "Sweets & mithai", words: ["sweet", "mithai", "gulab", "jamun", "rasgulla", "barfi", "laddu", "jalebi", "halwa"] },
    { category: "Snacks & namkeen", words: ["namkeen", "chips", "snack", "sev", "mixture", "bhujia", "kurkure"] },
    { category: "Tea, coffee & beverages", words: ["tea", "chai", "coffee", "shake", "juice", "lassi", "soda", "cold drink", "beverage"] },
    { category: "Dairy & eggs", words: ["milk", "curd", "paneer packet", "cheese", "egg", "eggs", "butter", "ghee"] },
    { category: "Fruits", words: ["apple", "banana", "orange", "mango", "grapes", "watermelon", "papaya", "fruit"] },
    { category: "Vegetables", words: ["potato", "onion", "tomato", "capsicum", "vegetable", "sabzi"] },
    { category: "Puja, festive & gifts", words: ["puja", "pooja", "rakhi", "diya", "agarbatti", "incense"] },
  ];
  for (const rule of rules) {
    if (rule.words.some((word) => text.includes(word))) return rule.category;
  }
  return fallbackCategory;
}

function normalizeExtractedMenuItems(items, fallbackCategory) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const row of items.slice(0, 80)) {
    const title = cleanText(row && (row.title || row.name || row.item_name), 120);
    const rawPrice = row && (row.price != null ? row.price : row.rate);
    const price = Number(String(rawPrice == null ? "" : rawPrice).replace(/[^\d.]/g, ""));
    if (!title || !Number.isFinite(price) || price < 1) continue;
    const category = inferMenuCategory(row, fallbackCategory);
    if (!category || !ALLOWED_CATEGORIES.has(category)) continue;
    out.push({
      title,
      price: Math.round(price),
      category,
      description: cleanText(row && row.description, 300),
      package_size: cleanText(row && (row.package_size || row.size), 80),
      package_type: cleanText(row && (row.package_type || row.variant), 80),
      stock_unit: cleanText(row && row.stock_unit, 40),
      confidence: Math.max(0, Math.min(1, Number(row && row.confidence) || 0.75)),
    });
  }
  return out;
}

function responseOutputText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  const chunks = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    for (const c of Array.isArray(item?.content) ? item.content : []) {
      if (typeof c?.text === "string") chunks.push(c.text);
    }
  }
  return chunks.join("\n");
}

function dataUrlParts(src) {
  const match = String(src || "").match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function geminiApiKeys() {
  return [process.env.GEMINI_API_KEY, ...(process.env.GEMINI_API_KEYS || "").split(/[\n,;]/)]
    .map((key) => String(key || "").trim())
    .filter(Boolean)
    .filter((key, index, arr) => arr.indexOf(key) === index);
}

function groqApiKeys() {
  return [process.env.GROQ_API_KEY, ...(process.env.GROQ_API_KEYS || "").split(/[\n,;]/)]
    .map((key) => String(key || "").trim())
    .filter(Boolean)
    .filter((key, index, arr) => arr.indexOf(key) === index);
}

function openAiApiKeys() {
  return [
    process.env.OPENAI_API_KEY,
    ...(process.env.OPENAI_API_KEYS || "").split(/[\n,;]/),
  ]
    .map((key) => String(key || "").trim())
    .filter(Boolean)
    .filter((key, index, arr) => arr.indexOf(key) === index);
}

function isOpenAiQuotaError(data, status) {
  const code = String((data && data.error && data.error.code) || "").toLowerCase();
  const msg = String((data && data.error && data.error.message) || "").toLowerCase();
  return status === 429 && (code.includes("quota") || msg.includes("quota") || msg.includes("billing"));
}

function isQuotaError(data, status) {
  const code = String((data && data.error && (data.error.code || data.error.status)) || "").toLowerCase();
  const msg = String((data && data.error && data.error.message) || data.message || "").toLowerCase();
  return status === 429 && (code.includes("quota") || code.includes("resource_exhausted") || msg.includes("quota") || msg.includes("billing"));
}

function menuPrompt(fallbackCategory, translateToEnglish) {
  const languageRule = translateToEnglish
    ? "If the menu text is Hindi, Hinglish, or any Indian language, translate item names and descriptions into simple English for the listing title. "
    : "Keep item names in the language that is most readable from the menu unless a direct English name is obvious. ";
  return (
    "Extract sellable shop menu/catalog items from these images. Return only real product/menu rows with item name and price. " +
    "Ignore phone numbers, headings, shop address, offers without item price, totals, and decorative text. " +
    languageRule +
    `Choose category only from this valid list: ${CATEGORIES.join(", ")}. Use category '${fallbackCategory}' only when unsure. Prices are INR. Keep item names short for marketplace listings. ` +
    "Return JSON only in this shape: {\"items\":[{\"title\":\"\",\"price\":0,\"category\":\"\",\"description\":\"\",\"package_size\":\"\",\"package_type\":\"\",\"stock_unit\":\"\",\"confidence\":0.8}]}"
  );
}

function menuJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            price: { type: "number" },
            category: { type: "string" },
            description: { type: "string" },
            package_size: { type: "string" },
            package_type: { type: "string" },
            stock_unit: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["title", "price", "category", "description", "package_size", "package_type", "stock_unit", "confidence"],
        },
      },
    },
    required: ["items"],
  };
}

function selectedMenuProvider() {
  const requested = String(process.env.MENU_EXTRACT_PROVIDER || process.env.AI_MENU_PROVIDER || "auto").trim().toLowerCase();
  if (requested && requested !== "auto") return requested;
  if (geminiApiKeys().length) return "gemini";
  if (groqApiKeys().length) return "groq";
  if (openAiApiKeys().length) return "openai";
  return "";
}

async function callGeminiMenuExtract({ images, fallbackCategory, schema, translateToEnglish }) {
  const keys = geminiApiKeys();
  if (!keys.length) return { ok: false, status: 503, error: "GEMINI_API_KEY is not configured." };
  const model = process.env.GEMINI_MENU_MODEL || "gemini-3.5-flash";
  const parts = [{ text: menuPrompt(fallbackCategory, translateToEnglish) }];
  for (const src of images) {
    const parsed = dataUrlParts(src);
    if (!parsed) return { ok: false, status: 400, error: "Gemini menu images must be data URLs." };
    parts.push({ inline_data: { mime_type: parsed.mimeType, data: parsed.data } });
  }
  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
    },
  });
  let last = null;
  for (let i = 0; i < keys.length; i += 1) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: {
        "x-goog-api-key": keys[i],
        "Content-Type": "application/json",
      },
      body,
    });
    const data = await res.json().catch(() => ({}));
    last = { res, data };
    if (res.ok) {
      const text = (data.candidates || [])
        .flatMap((candidate) => (((candidate || {}).content || {}).parts || []))
        .map((part) => part && part.text)
        .filter(Boolean)
        .join("\n");
      return { ok: true, provider: "gemini", model, text };
    }
    if (!isQuotaError(data, res.status) || i === keys.length - 1) break;
  }
  return {
    ok: false,
    status: last && last.res ? last.res.status : 500,
    error: (last && last.data && last.data.error && last.data.error.message) || "Gemini menu extraction failed.",
  };
}

async function callGroqMenuExtract({ images, fallbackCategory, translateToEnglish }) {
  const keys = groqApiKeys();
  if (!keys.length) return { ok: false, status: 503, error: "GROQ_API_KEY is not configured." };
  const model = process.env.GROQ_MENU_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
  const content = [
    { type: "text", text: menuPrompt(fallbackCategory, translateToEnglish) },
    ...images.map((src) => ({ type: "image_url", image_url: { url: src } })),
  ];
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content }],
    response_format: { type: "json_object" },
    temperature: 0.1,
    max_completion_tokens: 4096,
    stream: false,
  });
  let last = null;
  for (let i = 0; i < keys.length; i += 1) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${keys[i]}`,
        "Content-Type": "application/json",
      },
      body,
    });
    const data = await res.json().catch(() => ({}));
    last = { res, data };
    if (res.ok) {
      return { ok: true, provider: "groq", model, text: data.choices?.[0]?.message?.content || "" };
    }
    if (!isQuotaError(data, res.status) || i === keys.length - 1) break;
  }
  return {
    ok: false,
    status: last && last.res ? last.res.status : 500,
    error: (last && last.data && last.data.error && last.data.error.message) || "Groq menu extraction failed.",
  };
}

async function callOpenAiMenuExtract({ images, fallbackCategory, schema, translateToEnglish }) {
  const apiKeys = openAiApiKeys();
  if (!apiKeys.length) return { ok: false, status: 503, error: "OPENAI_API_KEY is not configured." };
  const model = process.env.OPENAI_MENU_MODEL || "gpt-5.5";
  const content = [
    { type: "input_text", text: menuPrompt(fallbackCategory, translateToEnglish) },
    ...images.map((src) => ({ type: "input_image", image_url: src })),
  ];
  const requestBody = JSON.stringify({
    model,
    input: [{ role: "user", content }],
    text: {
      format: {
        type: "json_schema",
        name: "menu_items",
        strict: true,
        schema,
      },
    },
  });
  let last = null;
  for (let i = 0; i < apiKeys.length; i += 1) {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKeys[i]}`,
        "Content-Type": "application/json",
      },
      body: requestBody,
    });
    const data = await res.json().catch(() => ({}));
    last = { res, data };
    if (res.ok) return { ok: true, provider: "openai", model, text: responseOutputText(data) };
    if (!isOpenAiQuotaError(data, res.status) || i === apiKeys.length - 1) break;
  }
  return {
    ok: false,
    status: last && last.res ? last.res.status : 500,
    error: (last && last.data && last.data.error && last.data.error.message) || "OpenAI menu extraction failed.",
  };
}

function productQuantityFields(doc) {
  return {
    stock_quantity: doc.stockQuantity == null ? null : doc.stockQuantity,
    stock_unit: doc.stockUnit || "",
    package_type: doc.packageType || "",
    package_size: doc.packageSize || "",
  };
}

/** Buyer catalog: sale rate plus Bachat charges, no internal sellerPrice field name. */
function formatCatalogProduct(doc, seller, options = {}) {
  const id = doc._id;
  const price = buyerDisplayPrice(doc.sellerPrice, id, doc.mrp);
  const mrp = Number(doc.mrp);
  const showShopNames = options.showShopNames === true;
  const includeImages = options.includeImages !== false;
  const includeShopImages = options.includeShopImages !== false;
  return {
    product_id: String(id),
    title: doc.title,
    description: options.compact ? String(doc.description || "").slice(0, 220) : doc.description,
    category: doc.category,
    images: includeImages ? doc.images || [] : [],
    price,
    mrp: Number.isFinite(mrp) && mrp > 0 ? mrp : null,
    ...productQuantityFields(doc),
    shop_name: showShopNames ? seller?.shopName || "Shop" : maskedShopName("shop"),
    shop_name_locked: !showShopNames,
    shop_key: publicShopKey(seller),
    seller_id: seller?._id ? String(seller._id) : "",
    city: seller?.city || "",
    region: seller?.region || "",
    seller_verified: Boolean(seller?.isVerified),
    seller_kyc_pending: sellerTradeBlocked(seller),
    shop_photo: includeShopImages && Array.isArray(seller?.shopImages) ? seller.shopImages[0] || "" : "",
    shop_images: includeShopImages && Array.isArray(seller?.shopImages) ? seller.shopImages : [],
    shop_tagline: seller?.storefrontTagline || "",
    shop_menu_note: seller?.menuNote || "",
    shop_hours: publicBusinessHours(seller || {}),
  };
}

function formatCatalogShop(seller, productCount = 0, options = {}) {
  const showShopNames = options.showShopNames === true;
  const includeShopImages = options.includeShopImages !== false;
  const categories = sellerCategoryList(seller);
  return {
    shop_id: String(seller._id),
    shop_key: publicShopKey(seller),
    shop_name: showShopNames ? seller.shopName || "Shop" : maskedShopName("shop"),
    shop_name_locked: !showShopNames,
    seller_kyc_pending: sellerTradeBlocked(seller),
    city: seller.city || "",
    region: seller.region || "",
    seller_verified: Boolean(seller.isVerified),
    categories,
    category: categories[0] || seller.category || "",
    shop_photo: includeShopImages && Array.isArray(seller.shopImages) ? seller.shopImages[0] || "" : "",
    shop_images: includeShopImages && Array.isArray(seller.shopImages) ? seller.shopImages : [],
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
    mrp: doc.mrp == null ? null : doc.mrp,
    ...productQuantityFields(doc),
    is_active: doc.isActive,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  };
}

async function catalogItemsForLocation({ city, region, category, q, limit = 120, showShopNames = false, compact = false }) {
  const cleanCity = String(city || "").trim();
  const cleanRegion = String(region || "").trim();
  const sellers = await Seller.find({
    city: exactCiRegex(cleanCity),
    region: exactCiRegex(cleanRegion),
  })
    .select(compact
      ? "_id shopName city region isVerified businessHours storefrontTagline menuNote"
      : "_id shopName city region isVerified businessHours shopImages storefrontTagline menuNote")
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

  const productQuery = Product.find(filter);
  if (compact) productQuery.select("-images");
  const products = await productQuery
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();
  const sellerMap = Object.fromEntries(sellers.map((s) => [String(s._id), s]));
  return products.map((p) =>
    formatCatalogProduct(p, sellerMap[String(p.seller)], {
      showShopNames,
      compact,
      includeImages: !compact,
      includeShopImages: !compact,
    })
  );
}

async function catalogShopsForLocation({ city, region, showShopNames = false, compact = false }) {
  const cleanCity = String(city || "").trim();
  const cleanRegion = String(region || "").trim();
  const sellers = await Seller.find({
    city: exactCiRegex(cleanCity),
    region: exactCiRegex(cleanRegion),
  })
    .select(compact
      ? "_id shopName city region isVerified businessHours storefrontTagline menuNote categories category"
      : "_id shopName city region isVerified businessHours shopImages storefrontTagline menuNote categories category")
    .lean();
  if (!sellers.length) return [];

  const sellerIds = sellers.map((s) => s._id);
  const counts = await Product.aggregate([
    { $match: { seller: { $in: sellerIds }, isActive: true } },
    { $group: { _id: "$seller", count: { $sum: 1 } } },
  ]);
  const countMap = Object.fromEntries(counts.map((row) => [String(row._id), row.count]));
  return sellers
    .map((seller) => formatCatalogShop(seller, countMap[String(seller._id)] || 0, { showShopNames, includeShopImages: !compact }))
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
    const compact = req.query.compact === "1";
    const limit = queryLimit(req.query.limit, compact ? 32 : 120, 120);
    const items = await catalogItemsForLocation({ city, region, category, q, limit, showShopNames: canViewShopNames(user), compact });
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
    const compact = req.query.compact === "1";
    const limit = queryLimit(req.query.limit, compact ? 32 : 120, 120);
    const items = await catalogItemsForLocation({ city, region, category, q, limit, showShopNames: false, compact });
    res.set("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
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
    const compact = req.query.compact === "1";
    const shops = await catalogShopsForLocation({ city, region, showShopNames: canViewShopNames(user), compact });
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
    const compact = req.query.compact === "1";
    const shops = await catalogShopsForLocation({ city, region, showShopNames: false, compact });
    res.set("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    return res.json({ shops });
  } catch (e) {
    return next(e);
  }
});

router.post("/:productId/notify-seller-kyc", requireAuth, requireRole("buyer"), async (req, res, next) => {
  try {
    const pid = req.params.productId;
    if (!mongoose.isValidObjectId(pid)) {
      return badRequest(res, "Invalid product id");
    }
    const [product, buyer] = await Promise.all([
      Product.findOne({ _id: pid, isActive: true }).lean(),
      User.findById(req.user.id).lean(),
    ]);
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }
    const seller = await Seller.findById(product.seller).populate("user", "name email").lean();
    if (!seller) {
      return res.status(404).json({ error: "Seller not found" });
    }
    if (!sellerTradeBlocked(seller)) {
      return res.json({
        message: "This shop is verified now. You can add the product to your basket.",
        seller_kyc_pending: false,
      });
    }
    await notifySellerKycPending({ seller, buyer, product });
    return res.json({
      message: "Seller notified. We asked the shopkeeper to complete eKYC so you can buy from this shop.",
      seller_kyc_pending: true,
    });
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

router.post("/menu-extract", requireAuth, requireRole("seller"), async (req, res, next) => {
  try {
    const seller = await sellerForUser(req.user.id);
    if (!seller) return res.status(404).json({ error: "Seller profile not found" });
    const provider = selectedMenuProvider();
    if (!provider) {
      return res.status(503).json({
        error: "Menu extraction needs GEMINI_API_KEY, GROQ_API_KEY, or OPENAI_API_KEY configured on the server.",
      });
    }

    const fallbackCategory =
      canonicalCategory(req.body?.category) ||
      canonicalCategory((sellerCategoryList(seller) || [])[0]) ||
      canonicalCategory(seller.category);
    if (!fallbackCategory) {
      return badRequest(res, "Add at least one shop category before importing menu images.");
    }
    const images = Array.isArray(req.body?.images) ? req.body.images.slice(0, MENU_EXTRACT_MAX_IMAGES) : [];
    if (!images.length) return badRequest(res, "Upload at least one menu image.");
    const cleanImages = images.map((src) => String(src || "").trim()).filter(Boolean);
    if (!cleanImages.length) return badRequest(res, "Upload at least one menu image.");
    if (cleanImages.some((src) => src.length > MENU_EXTRACT_MAX_IMAGE_CHARS || !src.startsWith("data:image/"))) {
      return badRequest(res, "Menu images must be compressed image files.");
    }

    const schema = menuJsonSchema();
    const translateToEnglish = req.body?.translate_to_english !== false;
    let result;
    try {
      result =
        provider === "gemini"
          ? await callGeminiMenuExtract({ images: cleanImages, fallbackCategory, schema, translateToEnglish })
          : provider === "groq"
            ? await callGroqMenuExtract({ images: cleanImages, fallbackCategory, translateToEnglish })
            : provider === "openai"
              ? await callOpenAiMenuExtract({ images: cleanImages, fallbackCategory, schema, translateToEnglish })
              : { ok: false, status: 400, error: "MENU_EXTRACT_PROVIDER must be gemini, groq, openai, or auto." };
    } catch (e) {
      console.error("[menu-extract]", provider, e);
      const detail = e && e.message ? ` (${e.message})` : "";
      return res.status(502).json({
        error: `Menu extraction provider '${provider}' could not be reached. Check the API key, model name, and network connection${detail}.`,
      });
    }
    if (!result.ok) {
      const status = result.status >= 500 ? 502 : result.status || 400;
      return res.status(status).json({ error: result.error || "Menu extraction failed." });
    }
    const parsed = parseMaybeJson(result.text);
    const items = normalizeExtractedMenuItems(parsed && parsed.items, fallbackCategory);
    return res.json({ items, provider: result.provider, model: result.model });
  } catch (e) {
    return next(e);
  }
});

router.post("/", requireAuth, requireRole("seller"), requireSellerTradeUnblocked, async (req, res, next) => {
  try {
    const seller = await sellerForUser(req.user.id);
    if (!seller) return res.status(404).json({ error: "Seller profile not found" });

    const { title, description, category, images, price, mrp, stock_quantity, stock_unit, package_type, package_size } =
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

    const productMrp = normalizeMoney(mrp);
    if (Number.isNaN(productMrp)) {
      return badRequest(res, "MRP must be a number >= 1");
    }
    if (productMrp != null && productMrp < sellerPrice) {
      return badRequest(res, "MRP must be greater than or equal to your sale rate");
    }

    const stockQuantity = normalizeStockQuantity(stock_quantity);
    if (Number.isNaN(stockQuantity)) {
      return badRequest(res, "stock quantity must be a number >= 0");
    }

    const imgs = await externalizeImages(images, {
      maxItems: 8,
      maxChars: 850000,
      folder: "bachat/products",
      label: "product image",
    });

    const doc = await Product.create({
      seller: seller._id,
      title: String(title).trim().slice(0, 200),
      description: String(description || "").slice(0, 8000),
      category: canonical,
      images: imgs,
      sellerPrice,
      mrp: productMrp,
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

    const { title, description, category, images, price, mrp, stock_quantity, stock_unit, package_type, package_size, is_active } =
      req.body || {};
    if (title != null) doc.title = String(title).trim().slice(0, 200);
    if (description != null) doc.description = String(description).slice(0, 8000);
    if (category != null) {
      const c = canonicalCategory(category);
      if (!c || !ALLOWED_CATEGORIES.has(c)) return badRequest(res, "Invalid category");
      doc.category = c;
    }
    if (images != null) {
      const imgs = await externalizeImages(images, {
        maxItems: 8,
        maxChars: 850000,
        folder: "bachat/products",
        label: "product image",
      });
      doc.images = imgs;
    }
    if (price != null) {
      const sellerPrice = Number(price);
      if (!Number.isFinite(sellerPrice) || sellerPrice < 1) {
        return badRequest(res, "price must be a number ≥ 1");
      }
      doc.sellerPrice = sellerPrice;
    }
    if (mrp !== undefined) {
      const productMrp = normalizeMoney(mrp);
      if (Number.isNaN(productMrp)) {
        return badRequest(res, "MRP must be a number >= 1");
      }
      const nextSalePrice = price != null ? Number(price) : Number(doc.sellerPrice);
      if (productMrp != null && productMrp < nextSalePrice) {
        return badRequest(res, "MRP must be greater than or equal to your sale rate");
      }
      doc.mrp = productMrp;
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
