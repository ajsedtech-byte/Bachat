const { toE164India } = require("../lib/phone");

/**
 * Send SMS via Twilio when TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER are set.
 * Otherwise logs in development and returns { skipped: true }.
 */
async function sendVerificationSms(phone10, code) {
  const to = toE164India(phone10);
  if (!to) {
    throw new Error("Invalid phone for SMS");
  }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const body = `Your Bachat verification code is: ${code}. Valid for 10 minutes.`;

  if (!sid || !token || !from) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SMS not configured: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER");
    }
    console.info("[SMS dev] to=%s message=%s", to, body);
    return { skipped: true, to };
  }

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.error || res.statusText || "SMS send failed";
    throw new Error(msg);
  }
  return { sid: data.sid };
}

module.exports = { sendVerificationSms };
