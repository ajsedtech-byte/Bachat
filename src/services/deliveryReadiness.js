const User = require("../models/User");
const Seller = require("../models/Seller");
const { inIndiaBounds, normalizePreciseLocation } = require("../lib/location");
const { sendMail } = require("./email");

function appUrl() {
  return String(process.env.PUBLIC_APP_URL || "https://bachat.seekhen.com").replace(/\/+$/, "");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function deliveryPlaceIssue(label, rawLocation) {
  const loc = normalizePreciseLocation(rawLocation);
  if (loc.lat == null || loc.lng == null) {
    return `${label} GPS location is required.`;
  }
  if (!inIndiaBounds(loc.lat, loc.lng)) {
    return `${label} GPS location must be inside India.`;
  }
  if (!loc.addressText) {
    return `${label} address text is required.`;
  }
  return "";
}

function inspectCheckoutDeliveryReadiness({ buyer, seller }) {
  const buyerIssue = deliveryPlaceIssue("Your delivery address", buyer && buyer.location);
  const sellerIssue = deliveryPlaceIssue("Shop pickup address", seller && seller.location);
  const issues = {
    buyer: buyerIssue,
    seller: sellerIssue,
  };
  const missing = Object.entries(issues)
    .filter(([, issue]) => Boolean(issue))
    .map(([side]) => side);

  return {
    ok: missing.length === 0,
    issues,
    missing,
    message: missing.length
      ? "This order cannot be placed yet because delivery address details are incomplete."
      : "",
  };
}

function checkoutReadinessError(readiness) {
  const parts = [];
  if (readiness?.issues?.buyer) parts.push(readiness.issues.buyer);
  if (readiness?.issues?.seller) parts.push(readiness.issues.seller);
  const err = new Error(
    parts.length
      ? `This order cannot be placed yet. ${parts.join(" ")}`
      : "This order cannot be placed until delivery details are complete."
  );
  err.status = 400;
  err.code = "DELIVERY_ADDRESS_INCOMPLETE";
  err.readiness = readiness;
  return err;
}

async function notifyMissingCheckoutDeliveryDetails({ buyerId, sellerId, readiness }) {
  if (!readiness || readiness.ok) return;
  const [buyer, seller] = await Promise.all([
    buyerId ? User.findById(buyerId).lean() : null,
    sellerId ? Seller.findById(sellerId).populate("user", "email name").lean() : null,
  ]);

  const shopName = seller?.shopName || "this shop";
  const dashboardUrl = appUrl();
  const tasks = [];

  if (readiness.issues?.buyer && buyer?.email) {
    tasks.push(
      sendMail({
        to: buyer.email,
        subject: "Complete your delivery address to place your Bachat order",
        text:
          `Hi ${buyer.name || "there"},\n\n` +
          `You tried to order from ${shopName}, but your delivery address or GPS pin is missing.\n\n` +
          `Please open your Bachat address book, save your full address, confirm the GPS pin, and then place the order again.\n\n` +
          `${dashboardUrl}/UserDashboard.html#address-section`,
        html:
          `<p>Hi ${escapeHtml(buyer.name || "there")},</p>` +
          `<p>You tried to order from <strong>${escapeHtml(shopName)}</strong>, but your delivery address or GPS pin is missing.</p>` +
          "<p>Please open your Bachat address book, save your full address, confirm the GPS pin, and then place the order again.</p>" +
          `<p><a href="${escapeHtml(dashboardUrl)}/UserDashboard.html#address-section">Update delivery address</a></p>`,
      })
    );
  }

  const sellerEmail = seller?.user?.email;
  if (readiness.issues?.seller && sellerEmail) {
    tasks.push(
      sendMail({
        to: sellerEmail,
        subject: "Add your shop pickup address to receive Bachat orders",
        text:
          `Hi ${seller.user?.name || seller.shopName || "there"},\n\n` +
          `A customer wants to buy from ${shopName}, but your shop pickup address or GPS pin is missing.\n\n` +
          `Please open your shopkeeper dashboard, save the exact shop pickup address and GPS pin, and customers will be able to order from your shop.\n\n` +
          `${dashboardUrl}/ShopkeeperDashboard.html`,
        html:
          `<p>Hi ${escapeHtml(seller.user?.name || seller.shopName || "there")},</p>` +
          `<p>A customer wants to buy from <strong>${escapeHtml(shopName)}</strong>, but your shop pickup address or GPS pin is missing.</p>` +
          "<p>Please open your shopkeeper dashboard, save the exact shop pickup address and GPS pin, and customers will be able to order from your shop.</p>" +
          `<p><a href="${escapeHtml(dashboardUrl)}/ShopkeeperDashboard.html">Update shop pickup address</a></p>`,
      })
    );
  }

  const results = await Promise.allSettled(tasks);
  results.forEach((result) => {
    if (result.status === "rejected") {
      console.error("[delivery-readiness-mail:error]", result.reason?.message || result.reason);
    }
  });
}

module.exports = {
  checkoutReadinessError,
  deliveryPlaceIssue,
  inspectCheckoutDeliveryReadiness,
  notifyMissingCheckoutDeliveryDetails,
};
