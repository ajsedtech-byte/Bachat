const nodemailer = require("nodemailer");

let transporter;

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

  return tx.sendMail(payload);
}

module.exports = { sendMail };
