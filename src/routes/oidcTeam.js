const express = require("express");
const jwt = require("jsonwebtoken");
const { Issuer, generators } = require("openid-client");
const User = require("../models/User");
const { formatUser } = require("../lib/format");

const router = express.Router();

let clientPack = null;

function jwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) {
    throw new Error("JWT_SECRET is not configured");
  }
  return s;
}

function signToken(user) {
  return jwt.sign({ sub: String(user._id), role: user.role }, jwtSecret(), { expiresIn: "7d" });
}

function signMfaPendingToken(userId) {
  return jwt.sign({ sub: String(userId), purpose: "mfa_pending" }, jwtSecret(), { expiresIn: "10m" });
}

function signOidcHandoff(userId) {
  return jwt.sign({ sub: String(userId), purpose: "oidc_handoff" }, jwtSecret(), { expiresIn: "5m" });
}

async function getOidcClient() {
  const issuerUrl = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;
  const redirectUri = process.env.OIDC_REDIRECT_URI;
  if (!issuerUrl || !clientId || !redirectUri) {
    return null;
  }
  if (clientPack) {
    return clientPack;
  }
  const issuer = await Issuer.discover(issuerUrl);
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  const client = new issuer.Client({
    client_id: clientId,
    client_secret: clientSecret || undefined,
    redirect_uris: [redirectUri],
    response_types: ["code"],
  });
  clientPack = { issuer, client, redirectUri };
  return clientPack;
}

router.get("/team/status", async (_req, res, next) => {
  try {
    const pack = await getOidcClient().catch(() => null);
    return res.json({ team_oidc_enabled: !!pack });
  } catch (err) {
    return next(err);
  }
});

router.post("/team/exchange", async (req, res, next) => {
  try {
    const { code } = req.body || {};
    if (!code || typeof code !== "string") {
      return res.status(400).json({ error: "code is required" });
    }
    let payload;
    try {
      payload = jwt.verify(code, jwtSecret());
    } catch {
      return res.status(400).json({ error: "Invalid or expired code" });
    }
    if (payload.purpose !== "oidc_handoff" || !payload.sub) {
      return res.status(400).json({ error: "Invalid code purpose" });
    }
    const user = await User.findById(payload.sub).lean();
    if (!user || !["admin", "sales"].includes(user.role)) {
      return res.status(404).json({ error: "User not found" });
    }
    if (user.mfaTotpEnabled) {
      return res.json({
        mfa_required: true,
        mfa_token: signMfaPendingToken(user._id),
        user: { email: user.email, role: user.role },
      });
    }
    const full = await User.findById(user._id);
    return res.json({ token: signToken(full), user: formatUser(full) });
  } catch (err) {
    return next(err);
  }
});

router.get("/team/start", async (_req, res, next) => {
  try {
    const pack = await getOidcClient();
    if (!pack) {
      return res.status(501).json({ error: "Team OIDC is not configured (set OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_REDIRECT_URI)" });
    }
    const { client, redirectUri } = pack;
    const code_verifier = generators.codeVerifier();
    const code_challenge = generators.codeChallenge(code_verifier);
    const state = jwt.sign({ cv: code_verifier }, jwtSecret(), { expiresIn: "10m" });
    const url = client.authorizationUrl({
      scope: process.env.OIDC_SCOPES || "openid email profile",
      redirect_uri: redirectUri,
      state,
      code_challenge,
      code_challenge_method: "S256",
    });
    return res.redirect(url);
  } catch (err) {
    return next(err);
  }
});

router.get("/team/callback", async (req, res, next) => {
  try {
    const pack = await getOidcClient();
    if (!pack) {
      return res.redirect("/team-login.html?err=oidc_disabled");
    }
    const { client, redirectUri, issuer } = pack;
    const params = client.callbackParams(req);
    let decoded;
    try {
      decoded = jwt.verify(params.state, jwtSecret());
    } catch {
      return res.redirect("/team-login.html?err=oidc_state");
    }
    const code_verifier = decoded.cv;
    const tokenSet = await client.callback(redirectUri, params, { state: params.state, code_verifier });
    const claims = tokenSet.claims();
    const email = String(claims.email || "")
      .trim()
      .toLowerCase();
    if (!email) {
      return res.redirect("/team-login.html?err=oidc_no_email");
    }
    const user = await User.findOne({ email, role: { $in: ["admin", "sales"] } });
    if (!user) {
      return res.redirect("/team-login.html?err=oidc_no_team_user");
    }
    const iss = issuer.metadata.issuer;
    const sub = String(claims.sub || "");
    if (user.oidcSubject && user.oidcIssuer) {
      if (String(user.oidcSubject) !== sub || String(user.oidcIssuer) !== iss) {
        return res.redirect("/team-login.html?err=oidc_mismatch");
      }
    } else {
      user.oidcIssuer = iss;
      user.oidcSubject = sub;
      await user.save();
    }
    const handoff = signOidcHandoff(user._id);
    return res.redirect(`/team-login.html?oidc=1&code=${encodeURIComponent(handoff)}`);
  } catch (err) {
    console.error(err);
    return res.redirect("/team-login.html?err=oidc_callback");
  }
});

module.exports = router;
