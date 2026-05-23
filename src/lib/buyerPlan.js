function buyerPlan(user) {
  const value =
    user && (user.buyerPlan || user.plan || user.subscriptionPlan || user.membershipPlan || user.tier || "");
  return String(value || "free").trim().toLowerCase();
}

function canViewShopNames(user) {
  if (!user) return false;
  if (user.role === "admin" || user.role === "sales") return true;
  if (user.canViewShopNames === true || user.isPremium === true) return true;
  return ["premium", "pro", "plus", "paid"].includes(buyerPlan(user));
}

function publicShopKey(seller) {
  const id = seller && seller._id ? String(seller._id) : "";
  return id ? `local-shop-${id.slice(-6)}` : "local-shop";
}

function maskedShopName(kind) {
  return kind === "seller" ? "Local seller" : "Local shop";
}

module.exports = { buyerPlan, canViewShopNames, publicShopKey, maskedShopName };
