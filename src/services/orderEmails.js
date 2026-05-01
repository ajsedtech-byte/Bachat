const User = require("../models/User");
const Seller = require("../models/Seller");
const { sendMail } = require("./email");

function appUrl() {
  return (process.env.PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
}

function orderSummaryLine(order) {
  const items = order.lineItems || [];
  if (items.length) {
    return items.map((li) => `${li.title} ×${li.quantity}`).join(", ");
  }
  return "Custom request order";
}

/** Call after payment is confirmed (buyer + seller notifications). */
async function notifyOrderPaid(order) {
  const buyer = await User.findById(order.user).lean();
  const seller = await Seller.findById(order.seller).populate("user", "email name").lean();
  if (!buyer || !seller) return;

  const summary = orderSummaryLine(order);
  const amt = Number(order.totalAmount).toLocaleString("en-IN");
  const subjBuyer = `Payment received — Bachat`;
  const subjSeller = `New paid order — ₹${amt}`;

  await sendMail({
    to: buyer.email,
    subject: subjBuyer,
    text: `Hi ${buyer.name || ""},\n\nWe received your payment of ₹${amt} for: ${summary}.\n\nOrders: ${appUrl()}/UserDashboard.html\n`,
    html: `<p>Hi ${buyer.name || "there"},</p><p>We received your payment of <strong>₹${amt}</strong> for: ${summary}.</p><p><a href="${appUrl()}/UserDashboard.html">View your orders</a></p>`,
  });

  const sellerEmail = seller.user && seller.user.email;
  if (sellerEmail) {
    await sendMail({
      to: sellerEmail,
      subject: subjSeller,
      text: `New paid order on Bachat.\nAmount: ₹${amt}\n${summary}\n`,
      html: `<p>New paid order on Bachat.</p><p><strong>₹${amt}</strong></p><p>${summary}</p>`,
    });
  }
}

async function notifyOrderStatusToBuyer(order, prevStatus) {
  if (order.paymentStatus !== "paid") return;
  const buyer = await User.findById(order.user).lean();
  if (!buyer) return;

  const summary = orderSummaryLine(order);
  const map = {
    shipped: "Shipped",
    delivered: "Delivered",
    cancelled: "Cancelled",
    processing: "Processing",
  };
  const label = map[order.orderStatus] || order.orderStatus;
  if (prevStatus === order.orderStatus) return;

  await sendMail({
    to: buyer.email,
    subject: `Order update: ${label} — Bachat`,
    text: `Hi ${buyer.name || ""},\n\nYour order status is now: ${label}.\n${summary}\n`,
    html: `<p>Hi ${buyer.name || "there"},</p><p>Your order status is now <strong>${label}</strong>.</p><p>${summary}</p>`,
  });
}

module.exports = { notifyOrderPaid, notifyOrderStatusToBuyer };
