const express = require("express");
const mongoose = require("mongoose");
const Lead = require("../models/Lead");
const { requireAuth, requireRole } = require("../middleware/auth");
const { formatLead } = require("../lib/format");

const router = express.Router();
const LEAD_TYPES = Lead.LEAD_TYPES;
const LEAD_STAGES = Lead.LEAD_STAGES;

router.use(requireAuth, requireRole("admin", "sales"));

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function qsInt(v, def, min, max) {
  const n = parseInt(String(v), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function listFilter(req) {
  if (req.user.role === "admin") {
    return {};
  }
  return {
    $or: [{ ownerUser: null }, { ownerUser: req.user.id }],
  };
}

router.get("/", async (req, res, next) => {
  try {
    const limit = qsInt(req.query.limit, 50, 1, 100);
    const skip = qsInt(req.query.skip, 0, 0, 50000);
    const base = listFilter(req);
    const filter = { ...base };
    if (req.query.stage) {
      filter.stage = String(req.query.stage);
    }
    if (req.query.type) {
      filter.type = String(req.query.type);
    }
    const [total, rows] = await Promise.all([
      Lead.countDocuments(filter),
      Lead.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).populate("ownerUser", "name email").lean(),
    ]);
    return res.json({ total, items: rows.map((r) => formatLead(r)) });
  } catch (err) {
    return next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const { title, type, stage, city, region, notes, owner_user_id, meta } = req.body || {};
    if (!title || !String(title).trim()) {
      return badRequest(res, "title is required");
    }
    const t = String(type || "other").trim();
    if (!LEAD_TYPES.includes(t)) {
      return badRequest(res, "type must be one of: " + LEAD_TYPES.join(", "));
    }
    const st = String(stage || "new").trim();
    if (!LEAD_STAGES.includes(st)) {
      return badRequest(res, "stage must be one of: " + LEAD_STAGES.join(", "));
    }
    let owner = null;
    if (owner_user_id && mongoose.isValidObjectId(owner_user_id)) {
      owner = owner_user_id;
      if (req.user.role === "sales" && String(owner) !== String(req.user.id)) {
        return res.status(403).json({ error: "Sales users can only assign leads to themselves" });
      }
    } else if (req.user.role === "sales") {
      owner = req.user.id;
    }

    const doc = await Lead.create({
      title: String(title).trim().slice(0, 200),
      type: t,
      stage: st,
      city: String(city || "").trim().slice(0, 80),
      region: String(region || "").trim().slice(0, 80),
      notes: String(notes || "").slice(0, 8000),
      ownerUser: owner,
      meta: meta && typeof meta === "object" ? meta : {},
    });
    const populated = await Lead.findById(doc._id).populate("ownerUser", "name email").lean();
    return res.status(201).json(formatLead(populated));
  } catch (err) {
    return next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: "Not found" });
    }
    const existing = await Lead.findById(id).lean();
    if (!existing) {
      return res.status(404).json({ error: "Not found" });
    }
    if (req.user.role === "sales") {
      const mine =
        existing.ownerUser == null || String(existing.ownerUser) === String(req.user.id);
      if (!mine) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    const { title, type, stage, city, region, notes, owner_user_id, meta } = req.body || {};
    const set = {};
    if (title != null) set.title = String(title).trim().slice(0, 200);
    if (type != null) {
      const t = String(type).trim();
      if (!LEAD_TYPES.includes(t)) {
        return badRequest(res, "type must be one of: " + LEAD_TYPES.join(", "));
      }
      set.type = t;
    }
    if (stage != null) {
      const st = String(stage).trim();
      if (!LEAD_STAGES.includes(st)) {
        return badRequest(res, "stage must be one of: " + LEAD_STAGES.join(", "));
      }
      set.stage = st;
    }
    if (city != null) set.city = String(city).trim().slice(0, 80);
    if (region != null) set.region = String(region).trim().slice(0, 80);
    if (notes != null) set.notes = String(notes).slice(0, 8000);
    if (owner_user_id !== undefined) {
      if (owner_user_id === null || owner_user_id === "") {
        set.ownerUser = null;
      } else if (mongoose.isValidObjectId(owner_user_id)) {
        if (req.user.role === "sales" && String(owner_user_id) !== String(req.user.id)) {
          return res.status(403).json({ error: "Sales users can only assign to themselves" });
        }
        set.ownerUser = owner_user_id;
      } else {
        return badRequest(res, "Invalid owner_user_id");
      }
    }
    if (meta != null && typeof meta === "object") {
      set.meta = meta;
    }

    const doc = await Lead.findByIdAndUpdate(id, { $set: set }, { new: true }).populate("ownerUser", "name email").lean();
    return res.json(formatLead(doc));
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
