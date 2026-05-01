const jwt = require("jsonwebtoken");

function unauthorized(res, message = "Unauthorized") {
  return res.status(401).json({ error: message });
}

function forbidden(res, message = "Forbidden") {
  return res.status(403).json({ error: message });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return unauthorized(res, "Missing or invalid Authorization header");
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return res.status(500).json({ error: "JWT_SECRET is not configured" });
  }

  try {
    const payload = jwt.verify(token, secret);
    req.user = {
      id: payload.sub ? String(payload.sub) : null,
      role: payload.role || null,
    };
    if (!req.user.id) {
      return unauthorized(res, "Invalid token payload");
    }
    return next();
  } catch (_err) {
    return unauthorized(res, "Invalid or expired token");
  }
}

function requireRole(...roles) {
  const allowed = roles.flat();
  return (req, res, next) => {
    if (!req.user) {
      return unauthorized(res, "Authentication required");
    }
    if (!allowed.includes(req.user.role)) {
      return forbidden(res, "Insufficient role");
    }
    return next();
  };
}

module.exports = { requireAuth, requireRole };
