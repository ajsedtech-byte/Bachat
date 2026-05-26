const express = require("express");
const NotificationDelivery = require("../models/NotificationDelivery");
const NotificationCampaign = require("../models/NotificationCampaign");
const AnalyticsEvent = require("../models/AnalyticsEvent");

const router = express.Router();

async function mark(deliveryId, type) {
  const delivery = await NotificationDelivery.findById(deliveryId);
  if (!delivery) return null;
  const now = new Date();
  let newlyClicked = false;
  if (type === "open" && !delivery.openedAt) {
    delivery.openedAt = now;
    if (delivery.status === "sent") delivery.status = "opened";
  }
  if (type === "click" && !delivery.clickedAt) {
    delivery.clickedAt = now;
    delivery.status = "clicked";
    newlyClicked = true;
  }
  await delivery.save();
  if (delivery.campaign && newlyClicked) {
    await NotificationCampaign.updateOne({ _id: delivery.campaign }, { $inc: { clickedCount: 1 } }).catch(() => {});
  }
  await AnalyticsEvent.create({
    type: type === "click" ? "notification_clicked" : "notification_opened",
    user: delivery.user,
    meta: {
      delivery_id: String(delivery._id),
      campaign_id: delivery.campaign ? String(delivery.campaign) : "",
      channel: delivery.channel,
    },
  }).catch(() => {});
  return delivery;
}

router.get("/track/open/:deliveryId", async (req, res) => {
  await mark(req.params.deliveryId, "open").catch(() => null);
  const pixel = Buffer.from("R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store");
  return res.end(pixel);
});

router.get("/track/click/:deliveryId", async (req, res) => {
  await mark(req.params.deliveryId, "click").catch(() => null);
  const to = String(req.query.to || "/").trim();
  return res.redirect(to.startsWith("http") ? "/" : to || "/");
});

module.exports = router;
