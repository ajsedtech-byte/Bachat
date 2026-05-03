# Phase 3 — enterprise / ops scope (status)

Large modules from the original design mocks are **not** all implemented as first-class products. This file tracks intent vs what exists in the repo.

| Area | Status | Notes |
|------|--------|--------|
| Delivery pool & claims | **Partial** | `src/routes/delivery.js`, driver dashboards, `admin-delivery.html`, KYC flows |
| Disputes & refunds | **Partial** | No `Dispute` collection yet; `GET /api/admin/dispute-signals` lists risky orders |
| City / coverage heatmaps | **Planned** | No GIS warehouse |
| Field sales CRM | **Partial** | `GET /api/admin/sales-pipeline` counts only; no visits/leads entities |
| Compliance / KYC depth | **Partial** | Delivery KYC + DigiLocker hooks; see `docs/DELIVERY-KYC.md` |
| Notification centre | **Partial** | `GET /api/admin/notifications-summary`; no user-facing alert rules engine |
| Analytics warehouse | **Partial** | Admin overview + finance summary from Mongo; no BI export |
| Team portal / SSO / 2FA | **Planned** | `team-login.html` uses same password login as customers; wire your IdP + WebAuthn separately |

**Roadmap API:** `GET /api/admin/platform-modules` returns the same high-level labels for the admin UI.
