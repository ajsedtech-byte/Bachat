# Delivery partner KYC (Bachat)

## What the app does today

1. **Last-4 Aadhaar + optional PAN last-4** — Collected on `delivery-kyc.html` with explicit consent. Only four digits of Aadhaar are stored; the full UID must never be sent to this server.
2. **Admin review** — Submissions appear in `GET /api/admin/delivery-kyc/pending`. Admins approve or reject via `PATCH /api/admin/delivery-kyc/:userId` with `status: "verified"` or `"rejected"`.
3. **Dev auto-verify** — If `NODE_ENV` is not `production` or `DELIVERY_KYC_AUTO_VERIFY=1`, submit can auto-verify (see `src/routes/auth.js`). Turn **off** auto-verify in production unless you accept that risk.
4. **DigiLocker (optional)** — OAuth and issued-document **metadata** sync exist under `/api/digilocker` when env vars are set. Binary/XML fetch is gated off by default. Partner registration on the [Meri Pehchaan / DigiLocker partner portal](https://dlpartners.meripehchaan.gov.in/) is required for production use.

## What is *not* implemented

- **Full UIDAI eKYC** (OTP Aadhaar, XML KYC, biometric capture) as a first-party integration.
- **Automated document OCR** of Aadhaar/PAN images (partners may offer this separately).

## Product / legal checklist before go-live

- Define **purpose**, **notice**, and **retention** for identity data with qualified counsel.
- Decide whether **DigiLocker metadata** and/or **last-4** meets your KYC obligation for delivery partners in your jurisdiction.
- Register **SMS templates** (India DLT) if you send OTPs by SMS for any flow.
- Run delivery pool and assignment rules under `src/routes/delivery.js` with staging data.
