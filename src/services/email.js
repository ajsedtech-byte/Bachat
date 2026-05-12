const nodemailer = require("nodemailer");

let transporter;

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

async function sendMail({ to, subject, text, html }) {
  if (!to || !subject) {
    throw new Error("sendMail requires `to` and `subject`");
  }

  const tx = getTransporter();
  const payload = {
    from: fromAddress(),
    to,
    subject,
    text: text || "",
    html: html || undefined,
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
