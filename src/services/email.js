const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

let transporter;
const MAIL_HEADER_CID = "bachat-mail-header@bachat";

function buildMailDeliveryError(message, cause) {
  const err = new Error(message);
  err.status = 503;
  err.publicMessage = message;
  if (cause) {
    err.cause = cause;
  }
  return err;
}

function isMailAuthFailure(err) {
  const code = String(err && err.code ? err.code : "").toUpperCase();
  const responseCode = Number(err && err.responseCode);
  return code === "EAUTH" || responseCode === 534 || responseCode === 535;
}

function isMailConnectivityFailure(err) {
  const code = String(err && err.code ? err.code : "").toUpperCase();
  return ["ECONNECTION", "ESOCKET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH"].includes(code);
}

function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    transporter = null;
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  return transporter;
}

function fromAddress() {
  return (
    process.env.MAIL_FROM ||
    process.env.EMAIL_FROM ||
    process.env.SMTP_USER ||
    "no-reply@localhost"
  );
}

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

function mailHeaderImageUrl() {
  return String(process.env.MAIL_HEADER_IMAGE_URL || `${appBaseUrl()}/assets/bachat-mail-header.png`).trim();
}

function mailHeaderImagePath() {
  return path.join(__dirname, "..", "..", "public", "assets", "bachat-mail-header.png");
}

function mailHeaderAttachment() {
  const filePath = mailHeaderImagePath();
  if (!fs.existsSync(filePath)) return null;
  return {
    filename: "bachat-mail-header.png",
    path: filePath,
    cid: MAIL_HEADER_CID,
    contentType: "image/png",
  };
}

function textToHtml(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map((part) => `<p>${escapeHtml(part).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function withBachatMailShell({ subject, text, html, headerImageSrc }) {
  const bodyHtml = html || textToHtml(text);
  if (!bodyHtml) return undefined;
  if (String(bodyHtml).includes('data-bachat-mail-shell="1"')) return bodyHtml;

  const safeSubject = escapeHtml(subject || "Bachat");
  const safeHeaderUrl = escapeHtml(headerImageSrc || mailHeaderImageUrl());

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${safeSubject}</title>
  </head>
  <body style="margin:0;padding:0;background:#eef4fb;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#eef4fb;margin:0;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" data-bachat-mail-shell="1" style="max-width:640px;background:#ffffff;border:1px solid #d9e5f6;border-radius:18px;overflow:hidden;">
            <tr>
              <td style="padding:0;">
                <img src="${safeHeaderUrl}" alt="Bachat" width="640" style="display:block;width:100%;max-width:640px;height:auto;border:0;outline:none;text-decoration:none;">
              </td>
            </tr>
            <tr>
              <td style="padding:28px;font-size:15px;line-height:1.65;color:#0f172a;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="border-top:1px solid #e5edf8;padding:16px 28px;color:#64748b;font-size:12px;line-height:1.5;">
                This email was sent by Bachat.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendMail({ to, subject, text, html }) {
  if (!to || !subject) {
    throw new Error("sendMail requires `to` and `subject`");
  }

  const tx = getTransporter();
  const headerAttachment = mailHeaderAttachment();
  const payload = {
    from: fromAddress(),
    to,
    subject,
    text: text || "",
    html: withBachatMailShell({
      subject,
      text,
      html,
      headerImageSrc: headerAttachment ? `cid:${MAIL_HEADER_CID}` : mailHeaderImageUrl(),
    }),
    attachments: headerAttachment ? [headerAttachment] : undefined,
  };

  if (!tx) {
    // Dev-safe fallback when SMTP is not configured.
    console.log("[mail:mock]", { to, subject, text: payload.text });
    return { mocked: true };
  }

  try {
    return await tx.sendMail(payload);
  } catch (err) {
    console.error("[mail:error]", {
      to,
      subject,
      code: err && err.code ? err.code : "",
      responseCode: err && err.responseCode ? err.responseCode : "",
      command: err && err.command ? err.command : "",
      message: err && err.message ? err.message : "",
    });

    if (isMailAuthFailure(err)) {
      throw buildMailDeliveryError(
        "Email delivery is temporarily unavailable because the mail account could not be authenticated. Please try again shortly.",
        err
      );
    }
    if (isMailConnectivityFailure(err)) {
      throw buildMailDeliveryError(
        "Email delivery is temporarily unavailable right now. Please try again shortly.",
        err
      );
    }
    throw buildMailDeliveryError("We could not send email right now. Please try again shortly.", err);
  }
}

module.exports = { sendMail };
