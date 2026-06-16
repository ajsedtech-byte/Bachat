const NotificationDelivery = require("../models/NotificationDelivery");
const { sendMail } = require("./email");

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function appBaseUrl() {
  return String(process.env.PUBLIC_APP_URL || "https://bachat.seekhen.com").replace(/\/+$/, "");
}

function sellerKycReminderMail({ sellerName, buyerName, productTitle }) {
  const safeSellerName = sellerName || "Shopkeeper";
  const safeBuyerName = buyerName || "A Bachat customer";
  const safeProductTitle = productTitle || "your product";
  const dashboardUrl = `${appBaseUrl()}/seller-kyc.html`;
  return {
    subject: "Customers want to buy from your shop - complete Bachat eKYC",
    text:
      `Hi ${safeSellerName},\n\n` +
      `${safeBuyerName} wants to buy ${safeProductTitle} from your shop on Bachat.\n\n` +
      "Your shop eKYC is still pending, so customers cannot place orders from your shop yet. Please complete your eKYC to start selling products and accepting orders.\n\n" +
      `Complete eKYC here: ${dashboardUrl}\n\n` +
      "Thank you,\nBachat",
    html:
      `<p>Hi <strong>${escapeHtml(safeSellerName)}</strong>,</p>` +
      `<p><strong>${escapeHtml(safeBuyerName)}</strong> wants to buy <strong>${escapeHtml(safeProductTitle)}</strong> from your shop on Bachat.</p>` +
      "<p>Your shop eKYC is still pending, so customers cannot place orders from your shop yet. Please complete your eKYC to start selling products and accepting orders.</p>" +
      `<p><a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:#0056d2;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:10px;">Complete eKYC</a></p>` +
      "<p>Thank you,<br>Bachat</p>",
  };
}

async function notifySellerKycPending({ seller, buyer, product }) {
  const sellerUser = seller && seller.user && typeof seller.user === "object" ? seller.user : null;
  if (!sellerUser || !sellerUser._id) {
    return { email_sent: false, notification_saved: false };
  }

  const productTitle = product?.title || "your product";
  const buyerName = buyer?.name || buyer?.email || "A Bachat customer";
  const title = "Customer wants to buy from your shop";
  const body = `${buyerName} wants to buy ${productTitle}. Complete your eKYC to start accepting orders.`;

  await NotificationDelivery.create({
    user: sellerUser._id,
    channel: "in_app",
    title,
    body,
    status: "sent",
    sentAt: new Date(),
    clickUrl: "/seller-kyc.html",
  });

  let emailSent = false;
  if (sellerUser.email) {
    const mail = sellerKycReminderMail({
      sellerName: sellerUser.name || seller.shopName || "",
      buyerName,
      productTitle,
    });
    try {
      await sendMail({
        to: sellerUser.email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      emailSent = true;
    } catch (err) {
      console.error("[seller-kyc-buyer-reminder-mail]", err.message || err);
    }
  }

  return { email_sent: emailSent, notification_saved: true };
}

module.exports = { notifySellerKycPending };
