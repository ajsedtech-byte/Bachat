/**
 * DigiLocker OAuth 2.0 (Meri Pehchaan) — partner integration helpers.
 * @see https://digilocker.meripehchaan.gov.in/ and “Digital Locker Authorized Partner API Specification”.
 *
 * Implements: authorize URL, token exchange, issued-document list (metadata), optional file/XML fetch
 * with HMAC verification. Do not log access tokens or downloaded payloads. Production still requires
 * partner registration, HTTPS redirect URI, agreed scopes, privacy policy, and legal review — see .env.example.
 */

const crypto = require("crypto");

const AUTH_BASE = "https://digilocker.meripehchaan.gov.in/public/oauth2/1";
/** Spec revisions also mention `/public/oauth2/2/token` — if token exchange fails, confirm with your portal docs. */
const TOKEN_URL = `${AUTH_BASE}/token`;
const AUTH_URL = `${AUTH_BASE}/authorize`;
/** Partner spec: GET list of issued documents (Bearer). */
const ISSUED_LIST_URL = "https://digilocker.meripehchaan.gov.in/public/oauth2/2/files/issued";
const FILE_URI_BASE = "https://digilocker.meripehchaan.gov.in/public/oauth2/1/file";
const XML_URI_BASE = "https://digilocker.meripehchaan.gov.in/public/oauth2/1/xml";

function digilockerEnv() {
  const clientId = String(process.env.DIGILOCKER_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.DIGILOCKER_CLIENT_SECRET || "").trim();
  const redirectUri = String(process.env.DIGILOCKER_REDIRECT_URI || "").trim();
  const allowFileFetch = String(process.env.DIGILOCKER_ALLOW_FILE_FETCH || "").trim() === "1";
  const fetchMaxBytes = Math.min(
    Math.max(parseInt(process.env.DIGILOCKER_FETCH_MAX_BYTES || "2097152", 10) || 2097152, 1024),
    10 * 1024 * 1024
  );
  return {
    clientId,
    clientSecret,
    redirectUri,
    configured: Boolean(clientId && clientSecret && redirectUri),
    allowFileFetch,
    fetchMaxBytes,
  };
}

function oauthScopeParam() {
  if (process.env.DIGILOCKER_OAUTH_SCOPE === "") return "";
  return String(process.env.DIGILOCKER_OAUTH_SCOPE || "openid").trim();
}

function randomState() {
  return crypto.randomBytes(24).toString("hex");
}

function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const u = new URL(AUTH_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  const scope = oauthScopeParam();
  if (scope) u.searchParams.set("scope", scope);
  return u.toString();
}

/**
 * Exchange authorization code for tokens (DigiLocker form POST).
 * @returns {Promise<{ access_token?: string, raw: object }>}
 */
async function exchangeAuthorizationCode(code, redirectUri, clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: String(code || "").trim(),
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const raw = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = raw.error_description || raw.error || raw.message || `Token HTTP ${res.status}`;
    throw new Error(msg);
  }
  return { access_token: raw.access_token, raw };
}

/**
 * GET issued documents metadata (no file bodies).
 */
async function listIssuedDocuments(accessToken) {
  const res = await fetch(ISSUED_LIST_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const raw = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = raw.error_description || raw.error || `issued list HTTP ${res.status}`;
    throw new Error(msg);
  }
  const items = Array.isArray(raw.items) ? raw.items : [];
  return items;
}

function normalizeIssuedItem(it) {
  if (!it || String(it.type || "").toLowerCase() !== "file") return null;
  const uri = String(it.uri || "").trim();
  if (!uri) return null;
  return {
    name: String(it.name || "").slice(0, 500),
    description: String(it.description || "").slice(0, 500),
    doctype: String(it.doctype || "").slice(0, 32),
    mime: String(it.mime || "").slice(0, 128),
    date: String(it.date || "").trim().slice(0, 64),
    issuer: String(it.issuer || "").slice(0, 256),
    issuerid: String(it.issuerid || "").slice(0, 128),
    uri,
  };
}

function verifyDlHmac(buffer, hmacHeader, clientSecret) {
  if (!hmacHeader || !clientSecret) return true;
  const calc = crypto.createHmac("sha256", clientSecret).update(buffer).digest("base64");
  return calc === String(hmacHeader).trim();
}

/**
 * Download issued/uploaded file bytes (Partner “Get File from URI”).
 * Verifies DigiLocker HMAC when client secret is configured.
 */
async function fetchFileFromUri(accessToken, uri, clientSecret, maxBytes) {
  const url = `${FILE_URI_BASE}/${encodeURIComponent(uri)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const hmacHeader = res.headers.get("hmac") || res.headers.get("Hmac") || "";
  if (ct === "application/json") {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error_description || j.error || "DigiLocker file error");
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new Error(`File exceeds configured max size (${maxBytes} bytes)`);
  }
  if (!verifyDlHmac(buf, hmacHeader, clientSecret)) {
    throw new Error("File integrity check failed (HMAC mismatch)");
  }
  return { buffer: buf, contentType: res.headers.get("content-type") || "application/octet-stream" };
}

/** Certificate XML for a URI (may contain masked Aadhaar — treat as sensitive). */
async function fetchXmlFromUri(accessToken, uri, clientSecret, maxBytes) {
  const url = `${XML_URI_BASE}/${encodeURIComponent(uri)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const hmacHeader = res.headers.get("hmac") || res.headers.get("Hmac") || "";
  if (ct.includes("json")) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error_description || j.error || "DigiLocker XML error");
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new Error(`XML exceeds configured max size (${maxBytes} bytes)`);
  }
  if (!verifyDlHmac(buf, hmacHeader, clientSecret)) {
    throw new Error("XML integrity check failed (HMAC mismatch)");
  }
  return { buffer: buf, contentType: res.headers.get("content-type") || "application/xml" };
}

module.exports = {
  digilockerEnv,
  randomState,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  listIssuedDocuments,
  normalizeIssuedItem,
  fetchFileFromUri,
  fetchXmlFromUri,
};
