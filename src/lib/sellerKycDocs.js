const SELLER_KYC_DOC_KINDS = Object.freeze([
  "shop_photo",
  "gst_cert",
  "aadhaar",
  "udyam",
  "pan",
  "government_id",
  "proof_of_address",
  "business_registration",
  "banking_details",
  "other",
]);

const FIELD_SALES_REQUIRED_DOC_KINDS = Object.freeze([
  "aadhaar",
  "pan",
  "government_id",
  "proof_of_address",
  "business_registration",
  "banking_details",
]);

const MAX_DOC_CHARS = 900000;
const MAX_DOCS = 12;

module.exports = {
  SELLER_KYC_DOC_KINDS,
  FIELD_SALES_REQUIRED_DOC_KINDS,
  MAX_DOC_CHARS,
  MAX_DOCS,
};
