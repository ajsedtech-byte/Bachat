/**
 * Canonical shop / product categories — India-focused (Flipkart / BigBasket / DMart–style buckets).
 * Keep in sync: HTML clients load from GET /api/categories when possible.
 */
const CATEGORIES = [
  // —— Fresh & kitchen (India daily needs) ——
  "Atta, rice, dal & oil",
  "Bakery & cakes",
  "Dairy & eggs",
  "Food",
  "Fruits",
  "Groceries",
  "Meat, fish & poultry",
  "Organic & health foods",
  "Snacks & namkeen",
  "Spices & masalas",
  "Sweets & mithai",
  "Tea, coffee & beverages",
  "Vegetables",

  // —— Fashion & lifestyle ——
  "Bags & luggage",
  "Ethnic wear, sarees & kurtis",
  "Eyewear",
  "Fashion",
  "Footwear",
  "Innerwear & sleepwear",
  "Jewellery & watches",
  "Kids & baby clothing",
  "Men's clothing",
  "Women's clothing",

  // —— Electronics & appliances ——
  "Cameras & accessories",
  "Computer Parts",
  "Computers & laptops",
  "Electronics",
  "Home Appliances",
  "Mobile phones & accessories",
  "Mobile Services",
  "Smart wearables & gadgets",
  "TV & home entertainment",

  // —— Home, kitchen & improvement ——
  "Cleaning & household",
  "Furniture",
  "Hardware, paint & electrical",
  "Home & daily",
  "Home decor",
  "Home furnishings & linen",
  "Kitchen & dining",
  "Kitchenware & cookware",
  "Tools & DIY",

  // —— Beauty, health & family ——
  "Baby care",
  "Beauty & personal care",
  "Health & wellness",
  "Mom & maternity",
  "Pharmacy & OTC",

  // —— Mobility, work & play ——
  "Automotive",
  "Books & media",
  "Handloom & handicrafts",
  "Industrial & institutional",
  "Music & instruments",
  "Pet supplies",
  "Puja, festive & gifts",
  "Sports, toys & fitness",
  "Stationery & office supplies",
  "Two wheelers & parts",

  // —— Farm, garden & services ——
  "Agriculture & gardening",
  "Services — repairs & more",

  "General items",
];

const CATEGORY_SET = new Set(CATEGORIES);
const CATEGORY_MAP = new Map(
  CATEGORIES.map((category) => [String(category || "").trim().toLowerCase(), category])
);

function categoryKey(input) {
  return String(input || "").trim().toLowerCase();
}

function canonicalCategory(input) {
  return CATEGORY_MAP.get(categoryKey(input)) || null;
}

/**
 * Normalize client input to a unique list of allowed category strings.
 * Accepts: string[], single string (legacy), or comma-separated string.
 */
function normalizeSellerCategories(input) {
  let arr = [];
  if (Array.isArray(input)) {
    arr = input;
  } else if (input != null && String(input).trim()) {
    const s = String(input).trim();
    if (s.includes(",")) {
      arr = s.split(",").map((x) => x.trim());
    } else {
      arr = [s];
    }
  }
  const out = [];
  const seen = new Set();
  for (const c of arr) {
    const t = canonicalCategory(c);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Resolved category list for a seller document (supports legacy `category` only). */
function sellerCategoryList(sellerDoc) {
  if (!sellerDoc) return [];
  const o = sellerDoc.toObject ? sellerDoc.toObject() : sellerDoc;
  if (Array.isArray(o.categories) && o.categories.length) {
    return o.categories.map(canonicalCategory).filter(Boolean);
  }
  const legacy = canonicalCategory(o.category);
  if (legacy) {
    return [legacy];
  }
  return [];
}

module.exports = {
  CATEGORIES,
  CATEGORY_SET,
  canonicalCategory,
  normalizeSellerCategories,
  sellerCategoryList,
};
