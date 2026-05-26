const mongoose = require("mongoose");

const cityAreaSchema = new mongoose.Schema(
  {
    city: { type: String, required: true, trim: true, maxlength: 80 },
    region: { type: String, required: true, trim: true, maxlength: 80 },
    active: { type: Boolean, default: true, index: true },
    priority: { type: String, enum: ["low", "normal", "high"], default: "normal" },
    serviceRadiusKm: { type: Number, default: 5, min: 0, max: 100 },
    lat: { type: Number, default: null, min: -90, max: 90 },
    lng: { type: Number, default: null, min: -180, max: 180 },
    notes: { type: String, default: "", trim: true, maxlength: 1000 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

cityAreaSchema.index({ city: 1, region: 1 }, { unique: true });

module.exports = mongoose.model("CityArea", cityAreaSchema);
