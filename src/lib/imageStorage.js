const DATA_URL_RE = /^data:([^;,]+);base64,/i;
const HTTP_URL_RE = /^https?:\/\//i;

function imageStorageConfigured() {
  return Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_UPLOAD_PRESET);
}

function badImageRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

async function uploadDataUrlToCloudinary(dataUrl, folder) {
  if (!imageStorageConfigured()) {
    throw badImageRequest(
      "Image storage is not configured. Set CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET, or provide image URLs."
    );
  }

  const cloud = String(process.env.CLOUDINARY_CLOUD_NAME).trim();
  const preset = String(process.env.CLOUDINARY_UPLOAD_PRESET).trim();
  const form = new FormData();
  form.set("file", dataUrl);
  form.set("upload_preset", preset);
  if (folder) form.set("folder", folder);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/image/upload`, {
    method: "POST",
    body: form,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.secure_url) {
    throw badImageRequest((data && data.error && data.error.message) || "Image upload failed.");
  }
  return data.secure_url;
}

async function externalizeImages(raw, options = {}) {
  if (!Array.isArray(raw)) return [];
  const maxItems = options.maxItems || 8;
  const maxChars = options.maxChars || 850000;
  const folder = options.folder || "bachat";
  const label = options.label || "image";
  const out = [];

  for (const item of raw.slice(0, maxItems)) {
    const src = String(item || "").trim();
    if (!src) continue;
    if (src.length > maxChars) {
      throw badImageRequest(`Each ${label} is too large; use smaller files or image links.`);
    }
    if (HTTP_URL_RE.test(src) || src.startsWith("/")) {
      out.push(src);
      continue;
    }
    if (DATA_URL_RE.test(src)) {
      out.push(await uploadDataUrlToCloudinary(src, folder));
      continue;
    }
    throw badImageRequest(`Use a valid ${label} URL or upload a supported image file.`);
  }

  return out;
}

module.exports = {
  externalizeImages,
  imageStorageConfigured,
};
