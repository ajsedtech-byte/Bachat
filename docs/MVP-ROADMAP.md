# Bachat — MVP roadmap (product clarity)

Design mocks show a **full platform** (buyer, shopkeeper, sales, city ops, delivery partners, disputes, analytics, compliance, team 2FA). This repo ships a **narrower MVP** first, then layers the rest.

## Shipped in repo (MVP core)

| Capability | Notes |
|------------|--------|
| Auth | Email + password, JWT, roles `buyer`, `seller`, `admin`, `delivery`; email verify; **forgot/reset password** (`POST /api/auth/forgot-password`, `reset-password`); **email OTP login**; phone on profile confirmed via **email code** (not SMS by default). |
| Buyer | Local **catalog** (city/region), **cart**, **post request**, **list requests**, **view quotes per request**, **place order from quote** (`POST /api/orders` with `quote_id`). |
| Shopkeeper | **Products CRUD**, **open requests** in area/categories, **inline quote form** on live requests, **quotes** list, **orders** tab. |
| Static marketing | `public/index.html` — landing; **blue UI** aligned to mocks. |
| Deploy | Express + `api/index.js` for Vercel; env via `.env.example` / `npm run setup`. |

## Phase 2 (near-term, still “marketplace core”)

- **Payments UX** after quote-order: Razorpay checkout + webhook already in API — wire buttons + status in dashboards.
- **Buyer saved list** — `GET/POST/DELETE /api/saved` + dashboard UI (prune inactive listings, “Find in shop” search).
- **Shopkeeper inline quotes** — done on live requests tab (`POST /api/quotes`).
- **Forgot / reset password** + **OTP login** — API + `forgot-password.html` / `reset-password.html`; OTP codes only returned in JSON if `EXPOSE_DEV_OTP=1`.

## Phase 3 (ops / enterprise — see `docs/PHASE3-STATUS.md`)

Partial implementations and placeholders include admin list pages (`/api/admin/users`, `sellers`, `requests`, `orders`, summaries), **dispute signals** (no full dispute model), delivery KYC (see `docs/DELIVERY-KYC.md`), and **`GET /api/admin/platform-modules`** for a live vs planned checklist in the admin UI.

Still largely **planned** as full products: city heatmaps, CRM visits/leads, analytics warehouse export, native team SSO/2FA.

## UI north star

- **Blue primary** (`blue-600`–`blue-950`), white surfaces, Inter/Mulish-style sans — see `public/login.html`, `public/index.html`, `public/UserDashboard.html`, `public/ShopkeeperDashboard.html`.
- Rich buyer dashboard: sidebar + KPIs + **request → quotes → choose → order** + browse + basket (implemented in `public/UserDashboard.html`).

## How to test the quote loop

1. **Buyer A** (city/region set): post a request in category X.  
2. **Seller B** (same city/region, category includes X): `POST /api/quotes` with `request_id`, `price`, etc.  
3. **Buyer A**: open dashboard → select request → see quotes → **Choose** → order created (`paymentStatus: pending` until payments wired).
