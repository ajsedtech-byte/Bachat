const User = require("../models/User");
const NotificationCampaign = require("../models/NotificationCampaign");
const NotificationDelivery = require("../models/NotificationDelivery");
const AnalyticsEvent = require("../models/AnalyticsEvent");
const { sendMail } = require("./email");

let running = false;
let timer = null;

function rolesForAudience(audience) {
  if (audience === "all") return ["buyer", "seller", "delivery", "sales", "admin"];
  if (audience === "buyers") return ["buyer"];
  if (audience === "sellers") return ["seller"];
  if (audience === "admins") return ["admin"];
  return [audience];
}

function audienceFilter(campaign) {
  const filter = { role: { $in: rolesForAudience(campaign.audience) } };
  if (campaign.city) filter.city = new RegExp(`^${escapeRegExp(campaign.city)}$`, "i");
  if (campaign.region) filter.region = new RegExp(`^${escapeRegExp(campaign.region)}$`, "i");
  return filter;
}

function escapeRegExp(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function markDelivery(delivery, status, extra = {}) {
  Object.assign(delivery, extra);
  delivery.status = status;
  if (status === "sent") delivery.sentAt = new Date();
  await delivery.save();
}

async function sendDelivery(delivery, user, campaign) {
  try {
    if (delivery.channel === "email") {
      const trackingBase = String(process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || "").replace(/\/+$/, "");
      const openUrl = trackingBase ? `${trackingBase}/api/notifications/track/open/${delivery._id}` : "";
      const clickUrl = trackingBase ? `${trackingBase}/api/notifications/track/click/${delivery._id}` : "";
      const text = `${delivery.body}${clickUrl ? `\n\nOpen: ${clickUrl}` : ""}`;
      const html =
        `<p>${escapeHtml(delivery.body).replace(/\n/g, "<br>")}</p>` +
        (clickUrl ? `<p><a href="${clickUrl}">Open in Bachat</a></p>` : "") +
        (openUrl ? `<img src="${openUrl}" width="1" height="1" alt="" />` : "");
      await sendMail({ to: user.email, subject: delivery.title || campaign.title, text, html });
    } else if (delivery.channel === "whatsapp" || delivery.channel === "sms") {
      await sendProviderWebhook(delivery.channel, delivery, user, campaign);
    }
    await markDelivery(delivery, "sent");
    return true;
  } catch (err) {
    await markDelivery(delivery, "failed", { error: err.message || "send_failed" });
    return false;
  }
}

async function sendProviderWebhook(channel, delivery, user, campaign) {
  const prefix = channel === "whatsapp" ? "WHATSAPP" : "SMS";
  const url = String(process.env[`${prefix}_WEBHOOK_URL`] || "").trim();
  const token = String(process.env[`${prefix}_WEBHOOK_TOKEN`] || "").trim();
  if (!url) {
    if (process.env.NODE_ENV === "production") throw new Error(`${channel}_provider_not_configured`);
    delivery.providerMessageId = `${channel}_dev_queued`;
    return;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      to: user.phone || user.email,
      user_id: String(user._id),
      campaign_id: String(campaign._id),
      delivery_id: String(delivery._id),
      channel,
      title: delivery.title,
      body: delivery.body,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${channel}_provider_failed`);
  delivery.providerMessageId = String(data.message_id || data.id || "");
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function dispatchCampaign(campaign, { batchSize = 500 } = {}) {
  const users = await User.find(audienceFilter(campaign)).select("_id email role city region").limit(batchSize).lean();
  let queued = 0;
  let sent = 0;
  let failed = 0;
  for (const user of users) {
    for (const channel of campaign.channels || ["in_app"]) {
      let delivery = await NotificationDelivery.findOne({ campaign: campaign._id, user: user._id, channel });
      if (!delivery) {
        delivery = await NotificationDelivery.create({
          campaign: campaign._id,
          user: user._id,
          channel,
          title: campaign.title,
          body: campaign.body,
          status: "queued",
        });
        queued += 1;
      }
      if (delivery.status === "queued") {
        if (channel === "in_app") {
          await markDelivery(delivery, "sent", {
            providerMessageId: "in_app",
          });
          sent += 1;
        } else {
          const ok = await sendDelivery(delivery, user, campaign);
          if (ok) sent += 1;
          else failed += 1;
        }
      }
    }
  }
  campaign.status = "sent";
  campaign.sentAt = campaign.sentAt || new Date();
  campaign.estimatedRecipients = users.length;
  campaign.sentCount = await NotificationDelivery.countDocuments({ campaign: campaign._id, status: { $in: ["sent", "opened", "clicked"] } });
  await campaign.save();
  await AnalyticsEvent.create({
    type: "notification_campaign_dispatched",
    meta: { campaign_id: String(campaign._id), queued, sent, failed, recipients: users.length },
  }).catch(() => {});
  return { queued, sent, failed, recipients: users.length };
}

async function dispatchDueCampaigns() {
  if (running) return { skipped: true };
  running = true;
  try {
    const now = new Date();
    const due = await NotificationCampaign.find({
      status: "scheduled",
      $or: [{ scheduledAt: null }, { scheduledAt: { $lte: now } }],
    }).limit(10);
    const results = [];
    for (const campaign of due) {
      results.push({ campaign_id: String(campaign._id), ...(await dispatchCampaign(campaign)) });
    }
    return { dispatched: results.length, results };
  } finally {
    running = false;
  }
}

function startNotificationDispatcherJob() {
  if (timer) return timer;
  const ms = Math.max(15000, Number(process.env.NOTIFICATION_DISPATCH_INTERVAL_MS || 60000));
  timer = setInterval(() => {
    dispatchDueCampaigns().catch((err) => console.error("[notifications]", err.message || err));
  }, ms);
  if (timer.unref) timer.unref();
  dispatchDueCampaigns().catch((err) => console.error("[notifications]", err.message || err));
  return timer;
}

module.exports = { dispatchCampaign, dispatchDueCampaigns, startNotificationDispatcherJob };
