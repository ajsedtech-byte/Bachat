const express = require("express");
const mongoose = require("mongoose");
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const User = require("../models/User");
const Seller = require("../models/Seller");
const { requireAuth, requireRole } = require("../middleware/auth");
const { buyerDisplayPrice } = require("../lib/buyerPrice");
const { ensureShopOpen, publicBusinessHours } = require("../lib/shopHours");
const { sellerTradeBlocked } = require("../lib/sellerKycGate");

const router = express.Router();

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function normText(value) {
  return String(value || "").trim().toLowerCase();
}

async function getOrCreateCart(userId) {
  let cart = await Cart.findOne({ user: userId });
  if (!cart) cart = await Cart.create({ user: userId, items: [] });
  return cart;
}

async function cartWithProducts(userId) {
  const cart = await getOrCreateCart(userId);
  const pids = cart.items.map((i) => i.product);
  const products = await Product.find({ _id: { $in: pids } }).lean();
  const sellerIds = [...new Set(products.map((p) => String(p.seller)))];
  const sellers = sellerIds.length ? await Seller.find({ _id: { $in: sellerIds } }).lean() : [];
  const sellerMap = Object.fromEntries(sellers.map((s) => [String(s._id), s]));
  const pmap = Object.fromEntries(products.map((p) => [String(p._id), p]));
  const items = cart.items
    .map((row) => {
      const p = pmap[String(row.product)];
      if (!p || !p.isActive) return null;
      const seller = sellerMap[String(p.seller)];
      const price = buyerDisplayPrice(p.sellerPrice, p._id, p.mrp);
      const mrp = Number(p.mrp);
      return {
        product_id: String(p._id),
        title: p.title,
        category: p.category,
        images: p.images || [],
        price,
        mrp: Number.isFinite(mrp) && mrp > 0 ? mrp : null,
        quantity: row.quantity,
        line_total: row.quantity * price,
        shop_name: seller?.shopName || "",
        seller_id: seller?._id ? String(seller._id) : "",
        seller_verified: Boolean(seller?.isVerified),
        seller_kyc_pending: sellerTradeBlocked(seller),
        shop_hours: publicBusinessHours(seller || {}),
      };
    })
    .filter(Boolean);
  return { cart, items };
}

router.use(requireAuth, requireRole("buyer"));

router.get("/", async (req, res, next) => {
  try {
    const out = await cartWithProducts(req.user.id);
    return res.json(out.items);
  } catch (err) {
    return next(err);
  }
});

router.post("/items", async (req, res, next) => {
  try {
    const { product_id, quantity = 1 } = req.body || {};
    if (!product_id || !mongoose.isValidObjectId(product_id)) {
      return badRequest(res, "product_id is required");
    }
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      return badRequest(res, "quantity must be an integer between 1 and 99");
    }

    const product = await Product.findOne({ _id: product_id, isActive: true }).lean();
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    const user = await User.findById(req.user.id).lean();
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    const seller = await Seller.findById(product.seller).lean();
    const city = String(user.city || "").trim();
    const region = String(user.region || "").trim();
    if (!city || !region) {
      return badRequest(res, "Set your city and region on your profile to add local items.");
    }
    if (!seller || normText(seller.city) !== normText(city) || normText(seller.region) !== normText(region)) {
      return res.status(400).json({ error: "This product is not available in your current city." });
    }
    if (sellerTradeBlocked(seller)) {
      return res.status(403).json({
        error: "This shop's eKYC is pending. Notify the seller to complete eKYC before you buy from this shop.",
        code: "SELLER_KYC_PENDING",
      });
    }
    const closedErr = ensureShopOpen(seller);
    if (closedErr) {
      return res.status(closedErr.status).json({
        error: closedErr.message,
        code: closedErr.code,
        shop_open_status: closedErr.shop_open_status,
      });
    }

    const cart = await getOrCreateCart(req.user.id);
    const idx = cart.items.findIndex((i) => String(i.product) === String(product_id));
    if (idx >= 0) {
      cart.items[idx].quantity = qty;
    } else {
      cart.items.push({ product: product_id, quantity: qty });
    }
    await cart.save();

    const out = await cartWithProducts(req.user.id);
    return res.status(201).json(out.items);
  } catch (err) {
    return next(err);
  }
});

router.patch("/items/:productId", async (req, res, next) => {
  try {
    const { productId } = req.params;
    if (!mongoose.isValidObjectId(productId)) return badRequest(res, "Invalid product id");
    const qty = Number(req.body?.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      return badRequest(res, "quantity must be an integer between 1 and 99");
    }
    const cart = await getOrCreateCart(req.user.id);
    const idx = cart.items.findIndex((i) => String(i.product) === String(productId));
    if (idx < 0) return res.status(404).json({ error: "Item not in cart" });
    const product = await Product.findOne({ _id: productId, isActive: true }).lean();
    if (!product) return res.status(404).json({ error: "Product not found" });
    const seller = await Seller.findById(product.seller).lean();
    if (!seller) return res.status(404).json({ error: "Seller not found" });
    if (sellerTradeBlocked(seller)) {
      return res.status(403).json({
        error: "This shop's eKYC is pending. Notify the seller to complete eKYC before you buy from this shop.",
        code: "SELLER_KYC_PENDING",
      });
    }
    const closedErr = ensureShopOpen(seller);
    if (closedErr) {
      return res.status(closedErr.status).json({
        error: closedErr.message,
        code: closedErr.code,
        shop_open_status: closedErr.shop_open_status,
      });
    }
    cart.items[idx].quantity = qty;
    await cart.save();
    const out = await cartWithProducts(req.user.id);
    return res.json(out.items);
  } catch (err) {
    return next(err);
  }
});

router.delete("/items/:productId", async (req, res, next) => {
  try {
    const { productId } = req.params;
    if (!mongoose.isValidObjectId(productId)) return badRequest(res, "Invalid product id");
    const cart = await getOrCreateCart(req.user.id);
    cart.items = cart.items.filter((i) => String(i.product) !== String(productId));
    await cart.save();
    const out = await cartWithProducts(req.user.id);
    return res.json(out.items);
  } catch (err) {
    return next(err);
  }
});

router.delete("/clear", async (req, res, next) => {
  try {
    const cart = await getOrCreateCart(req.user.id);
    cart.items = [];
    await cart.save();
    return res.json([]);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
