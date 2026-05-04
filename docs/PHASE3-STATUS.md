# Phase 3 — enterprise / ops scope (status)

Large modules from the original design mocks are **not** all implemented as first-class products. This file tracks intent vs what exists in the repo.

| Area | Status | Notes |
|------|--------|--------|
| Delivery pool & claims | **Partial** | `src/routes/delivery.js`, driver dashboards, `admin-delivery.html`, KYC flows |
| Disputes & refunds | **Live (v1)** | `Dispute` model + `POST/GET /api/disputes`, buyer/seller UI; `GET/PATCH /api/admin/disputes`; `dispute-signals` still for payment flags |
| City / coverage heatmaps | **Planned** | No GIS warehouse |
| Field sales CRM | **Live (v1)** | `Lead` model + `GET/POST/PATCH /api/leads` (admin + sales); `scripts/create-sales.js`; `admin-sales.html` |
| Compliance / KYC depth | **Partial** | Delivery KYC + DigiLocker hooks; see `docs/DELIVERY-KYC.md` |
| Notification centre | **Partial** | `GET /api/admin/notifications-summary`; no user-facing alert rules engine |
| Analytics warehouse | **Live (v1)** | `AnalyticsEvent` + `recordEvent` on requests/quotes/orders/payments/disputes; `GET /api/admin/analytics-events` & `analytics-rollup` |
| Team portal / SSO / 2FA | **Live (v1)** | TOTP MFA for `admin`/`sales` (`/api/auth/mfa/*`, `/api/auth/login/mfa`); optional OIDC (`/api/auth/oidc/team/*`, env in `.env.example`) |

**Roadmap API:** `GET /api/admin/platform-modules` returns the same high-level labels for the admin UI.
