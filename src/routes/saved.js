const express = require("express");
const mongoose = require("mongoose");
const User = require("../models/User");
const Product = require("../models/Product");
const { requireAuth, requireRole } = require("../middleware/auth");
const { buyerDisplayPrice } = require("../lib/buyerPrice");
const { canViewShopNames, maskedShopName, publicShopKey } = require("../lib/buyerPlan");

const router = express.Router();
const MAX_SAVED = 80;

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

router.get("/", requireAuth, requireRole("buyer"), async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id)
      .populate({
        path: "savedProducts",
        populate: { path: "seller", model: "Seller", select: "shopName city region" },
      })
      .lean();
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    const showShopNames = canViewShopNames(user);
    const items = (user.savedProducts || [])
      .filter((p) => p && p._id && p.isActive !== false && p.title)
      .map((p) => {
        const seller = p.seller;
        const price = buyerDisplayPrice(p.sellerPrice, p._id, p.mrp);
        const mrp = Number(p.mrp);
        return {
          product_id: String(p._id),
          title: p.title,
          price,
          mrp: Number.isFinite(mrp) && mrp > 0 ? mrp : null,
          category: p.category,
          images: p.images || [],
          shop_name: showShopNames ? seller?.shopName || "Shop" : maskedShopName("shop"),
          shop_name_locked: !showShopNames,
          shop_key: publicShopKey(seller),
          city: seller?.city || "",
          region: seller?.region || "",
        };
      });
    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

router.post("/", requireAuth, requireRole("buyer"), async (req, res, next) => {
  try {
    const { product_id } = req.body || {};
    if (!product_id || !mongoose.isValidObjectId(product_id)) {
      return badRequest(res, "product_id is required");
    }
    const product = await Product.findById(product_id).lean();
    if (!product || product.isActive === false) {
      return res.status(404).json({ error: "Product not found" });
    }
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    const list = user.savedProducts || [];
    if (list.some((id) => String(id) === String(product_id))) {
      return res.json({ saved_product_count: list.length });
    }
    if (list.length >= MAX_SAVED) {
      return badRequest(res, `You can save at most ${MAX_SAVED} items`);
    }
    user.savedProducts = [...list, product_id];
    await user.save();
    return res.json({ saved_product_count: user.savedProducts.length });
  } catch (err) {
    return next(err);
  }
});

router.delete("/:productId", requireAuth, requireRole("buyer"), async (req, res, next) => {
  try {
    const pid = req.params.productId;
    if (!mongoose.isValidObjectId(pid)) {
      return badRequest(res, "Invalid product id");
    }
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    user.savedProducts = (user.savedProducts || []).filter((id) => String(id) !== String(pid));
    await user.save();
    return res.json({ saved_product_count: user.savedProducts.length });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
