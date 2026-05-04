const mongoose = require("mongoose");

const LEAD_TYPES = ["seller_onboard", "buyer_campaign", "other"];
const LEAD_STAGES = ["new", "contacted", "qualified", "won", "lost"];

const leadSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    type: { type: String, enum: LEAD_TYPES, default: "other", index: true },
    stage: { type: String, enum: LEAD_STAGES, default: "new", index: true },
    city: { type: String, default: "", trim: true, maxlength: 80 },
    region: { type: String, default: "", trim: true, maxlength: 80 },
    notes: { type: String, default: "", maxlength: 8000 },
    ownerUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

leadSchema.index({ updatedAt: -1 });

const LeadModel = mongoose.model("Lead", leadSchema);
LeadModel.LEAD_TYPES = LEAD_TYPES;
LeadModel.LEAD_STAGES = LEAD_STAGES;
module.exports = LeadModel;
