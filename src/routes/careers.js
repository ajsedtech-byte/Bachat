const express = require("express");
const { sendMail } = require("../services/email");

const router = express.Router();

const CAREERS_TO = process.env.CAREERS_TO || "ajsedtech@gmail.com";
const MAX_RESUME_BYTES = 5 * 1024 * 1024;
const ALLOWED_RESUME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

function cleanText(value, max) {
  return String(value || "").trim().slice(0, max);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function resumeAttachment(resume) {
  if (!resume || typeof resume !== "object") {
    return null;
  }

  const name = cleanText(resume.name, 180) || "resume";
  let contentType = cleanText(resume.type, 120);
  const content = String(resume.content || "");
  const lowerName = name.toLowerCase();

  if (!contentType) {
    if (lowerName.endsWith(".pdf")) contentType = "application/pdf";
    if (lowerName.endsWith(".doc")) contentType = "application/msword";
    if (lowerName.endsWith(".docx")) {
      contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
  }

  if (!ALLOWED_RESUME_TYPES.has(contentType)) {
    const err = new Error("Resume must be a PDF, DOC, or DOCX file.");
    err.status = 400;
    throw err;
  }
  if (!content) {
    const err = new Error("Resume file is required.");
    err.status = 400;
    throw err;
  }

  const buffer = Buffer.from(content, "base64");
  if (!buffer.length || buffer.length > MAX_RESUME_BYTES) {
    const err = new Error("Resume must be 5 MB or smaller.");
    err.status = 400;
    throw err;
  }

  return {
    filename: name.replace(/[^\w.\- ()]/g, "_"),
    content: buffer,
    contentType,
  };
}

router.post("/", async (req, res, next) => {
  try {
    const name = cleanText(req.body && req.body.name, 120);
    const email = cleanText(req.body && req.body.email, 180).toLowerCase();
    const area = cleanText(req.body && req.body.area, 160);

    if (!name || !email || !area) {
      return badRequest(res, "name, email, and area are required");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return badRequest(res, "Enter a valid email address");
    }

    const attachment = resumeAttachment(req.body && req.body.resume);
    if (!attachment) {
      return badRequest(res, "Resume file is required");
    }

    const subject = `Bachat career application - ${name}`;
    const text = [
      "New career application submitted on Bachat.",
      "",
      `Name: ${name}`,
      `Email: ${email}`,
      `Area: ${area}`,
    ].join("\n");
    const html = [
      "<p>New career application submitted on Bachat.</p>",
      "<table role=\"presentation\" cellspacing=\"0\" cellpadding=\"0\" style=\"border-collapse:collapse;width:100%;max-width:520px;\">",
      `<tr><td style=\"padding:8px 0;color:#64748b;\">Name</td><td style=\"padding:8px 0;font-weight:700;\">${escapeHtml(name)}</td></tr>`,
      `<tr><td style=\"padding:8px 0;color:#64748b;\">Email</td><td style=\"padding:8px 0;font-weight:700;\"><a href=\"mailto:${escapeHtml(email)}\">${escapeHtml(email)}</a></td></tr>`,
      `<tr><td style=\"padding:8px 0;color:#64748b;\">Area</td><td style=\"padding:8px 0;font-weight:700;\">${escapeHtml(area)}</td></tr>`,
      "</table>",
      "<p>The resume is attached to this email.</p>",
    ].join("");

    await sendMail({
      to: CAREERS_TO,
      subject,
      text,
      html,
      attachments: [attachment],
    });

    return res.json({
      message: "Your form is submitted. Our team will reach you out soon.",
    });
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    return next(err);
  }
});

module.exports = router;
