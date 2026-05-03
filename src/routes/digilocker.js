/**
 * DigiLocker: OAuth, optional issued-document metadata sync, optional file/XML download.
 * Access tokens are kept in memory only (short TTL) — never persisted in MongoDB.
 */
const express = require("express");
const User = require("../models/User");
const { requireAuth, requireRole } = require("../middleware/auth");
const {
  digilockerEnv,
  randomState,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  listIssuedDocuments,
  normalizeIssuedItem,
  fetchFileFromUri,
  fetchXmlFromUri,
} = require("../lib/digilocker");

const router = express.Router();

/** state -> { userId, exp } (10 min) */
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

/** userId -> { accessToken, exp } — short-lived; for issued list + optional file fetch */
const accessSessions = new Map();
const ACCESS_SESSION_MAX_SEC = 900;
const ACCESS_SESSION_MIN_SEC = 30;

function sweepStates() {
  const now = Date.now();
  for (const [k, v] of pendingStates) {
    if (v.exp < now) pendingStates.delete(k);
  }
}

function sweepAccessSessions() {
  const now = Date.now();
  for (const [k, v] of accessSessions) {
    if (v.exp < now) accessSessions.delete(k);
  }
}

function setAccessSession(userId, accessToken, expiresInSec) {
  const raw = Number(expiresInSec);
  const sec = Math.min(
    Math.max(Number.isFinite(raw) && raw > 0 ? raw : 600, ACCESS_SESSION_MIN_SEC),
    ACCESS_SESSION_MAX_SEC
  );
  accessSessions.set(String(userId), {
    accessToken,
    exp: Date.now() + sec * 1000,
  });
}

function getAccessSession(userId) {
  sweepAccessSessions();
  const s = accessSessions.get(String(userId));
  if (!s || Date.now() > s.exp) {
    accessSessions.delete(String(userId));
    return null;
  }
  return s;
}

function clearAccessSession(userId) {
  accessSessions.delete(String(userId));
}

router.get("/status", (_req, res) => {
  const env = digilockerEnv();
  return res.json({
    enabled: env.configured,
    /** List metadata API is available when OAuth is configured. */
    issued_list_supported: env.configured,
    /** Binary/XML download — off until DIGILOCKER_ALLOW_FILE_FETCH=1 (legal + storage review). */
    file_fetch_enabled: Boolean(env.configured && env.allowFileFetch),
    fetch_max_bytes: env.fetchMaxBytes,
    /** Not a substitute for partner onboarding / MeitY or portal review. */
    partner_registration_required: true,
    legal_review_required: true,
  });
});

/** Delivery partner: returns { authorize_url, state } to start DigiLocker login. */
router.post("/authorize-url", requireAuth, requireRole("delivery"), async (req, res, next) => {
  try {
    sweepStates();
    const { clientId, clientSecret, redirectUri, configured } = digilockerEnv();
    if (!configured) {
      return res.status(503).json({ error: "DigiLocker is not configured on this server" });
    }
    const state = randomState();
    pendingStates.set(state, { userId: String(req.user.id), exp: Date.now() + STATE_TTL_MS });
    const authorize_url = buildAuthorizeUrl({ clientId, redirectUri, state });
    return res.json({ authorize_url, state });
  } catch (err) {
    return next(err);
  }
});

/**
 * After OAuth callback, sync issued-document metadata into deliveryKyc (no file bodies).
 * Requires an in-memory access session from the callback (short window).
 */
router.post("/pull-issued-meta", requireAuth, requireRole("delivery"), async (req, res, next) => {
  try {
    const sess = getAccessSession(req.user.id);
    if (!sess) {
      return res.status(400).json({
        error:
          "No active DigiLocker session. Open “Continue with DigiLocker” again, finish login, then retry within a few minutes.",
      });
    }
    try {
      const rawItems = await listIssuedDocuments(sess.accessToken);
      const normalized = [];
      for (const it of rawItems) {
        const n = normalizeIssuedItem(it);
        if (n) normalized.push(n);
        if (normalized.length >= 100) break;
      }
      await User.updateOne(
        { _id: req.user.id, role: "delivery" },
        {
          $set: {
            "deliveryKyc.digilockerIssuedSyncedAt": new Date(),
            "deliveryKyc.digilockerIssuedItems": normalized,
          },
        }
      );
      const preview = normalized.map(({ uri: _u, ...rest }) => rest);
      return res.json({ ok: true, count: normalized.length, items: preview });
    } catch (err) {
      return res.status(502).json({ error: err.message || "DigiLocker issued list failed" });
    }
  } catch (err) {
    return next(err);
  }
});

/**
 * Download one file the user already listed in digilockerIssuedItems (same access session).
 * Disabled unless DIGILOCKER_ALLOW_FILE_FETCH=1 — high sensitivity (Aadhaar/PAN in some PDFs/XML).
 */
router.post("/file", requireAuth, requireRole("delivery"), async (req, res, next) => {
  try {
    const env = digilockerEnv();
    if (!env.configured) {
      return res.status(503).json({ error: "DigiLocker is not configured" });
    }
    if (!env.allowFileFetch) {
      return res.status(403).json({
        error:
          "Server has not enabled DigiLocker file download (DIGILOCKER_ALLOW_FILE_FETCH). Requires legal and data-retention approval.",
      });
    }
    const sess = getAccessSession(req.user.id);
    if (!sess) {
      return res.status(400).json({ error: "No active DigiLocker session — complete OAuth again." });
    }
    const uri = String(req.body?.uri || "").trim();
    if (!uri) {
      return res.status(400).json({ error: "uri is required" });
    }
    const user = await User.findById(req.user.id).select("deliveryKyc.digilockerIssuedItems").lean();
    const allowed = (user?.deliveryKyc?.digilockerIssuedItems || []).some((x) => String(x.uri) === uri);
    if (!allowed) {
      return res.status(403).json({ error: "URI is not in your last issued-document sync — run pull-issued-meta first." });
    }
    const asXml = String(req.body?.format || "").toLowerCase() === "xml";
    try {
      const out = asXml
        ? await fetchXmlFromUri(sess.accessToken, uri, env.clientSecret, env.fetchMaxBytes)
        : await fetchFileFromUri(sess.accessToken, uri, env.clientSecret, env.fetchMaxBytes);
      res.setHeader("Content-Type", out.contentType);
      res.setHeader("Content-Length", String(out.buffer.length));
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(out.buffer);
    } catch (err) {
      return res.status(502).json({ error: err.message || "Download failed" });
    }
  } catch (err) {
    return next(err);
  }
});

/** Drop in-memory token (user can call after finishing downloads). */
router.post("/session/revoke", requireAuth, requireRole("delivery"), (req, res) => {
  clearAccessSession(req.user.id);
  return res.json({ ok: true });
});

/**
 * OAuth redirect target (DigiLocker redirects browser here with ?code=&state=).
 * Sets digilockerLinkedAt and stores a short-lived access session for issued-doc APIs.
 */
router.get("/callback", async (req, res, next) => {
  try {
    const { code, state } = req.query || {};
    const fail = (msg) => {
      const safe = String(msg || "Error")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      res.status(400).send(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>DigiLocker</title></head><body style="font-family:sans-serif;padding:2rem"><p><strong>DigiLocker</strong>: ${safe}</p><p><a href="/delivery-kyc.html">Back to KYC</a></p></body></html>`
      );
    };
    if (!code || !state) {
      return fail("Missing code or state");
    }
    sweepStates();
    const rec = pendingStates.get(String(state));
    if (!rec || rec.exp < Date.now()) {
      return fail("Invalid or expired state — try again from the KYC page");
    }
    pendingStates.delete(String(state));

    const { clientId, clientSecret, redirectUri, configured } = digilockerEnv();
    if (!configured) {
      return fail("Server misconfiguration");
    }

    let accessToken;
    let expiresIn;
    try {
      const x = await exchangeAuthorizationCode(code, redirectUri, clientId, clientSecret);
      accessToken = x.access_token;
      expiresIn = Number(x.raw.expires_in);
      if (!accessToken) {
        return fail("No access token in DigiLocker response");
      }
    } catch (e) {
      return fail(e.message || "Token exchange failed");
    }

    await User.updateOne(
      { _id: rec.userId, role: "delivery" },
      { $set: { "deliveryKyc.digilockerLinkedAt": new Date() } }
    );

    setAccessSession(rec.userId, accessToken, expiresIn);

    res.redirect(302, "/delivery-kyc.html?digilocker=1");
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
