const express = require("express");
const mongoose = require("mongoose");
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const User = require("../models/User");
const Seller = require("../models/Seller");
const { requireAuth, requireRole } = require("../middleware/auth");
const { buyerDisplayPrice } = require("../lib/buyerPrice");

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
  const pmap = Object.fromEntries(products.map((p) => [String(p._id), p]));
  const items = cart.items
    .map((row) => {
      const p = pmap[String(row.product)];
      if (!p || !p.isActive) return null;
      const price = buyerDisplayPrice(p.sellerPrice, p._id);
      return {
        product_id: String(p._id),
        title: p.title,
        category: p.category,
        images: p.images || [],
        price,
        quantity: row.quantity,
        line_total: row.quantity * price,
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
