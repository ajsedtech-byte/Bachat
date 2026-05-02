# Bachat — MVP roadmap (product clarity)

Design mocks show a **full platform** (buyer, shopkeeper, sales, city ops, delivery partners, disputes, analytics, compliance, team 2FA). This repo ships a **narrower MVP** first, then layers the rest.

## Shipped in repo (MVP core)

| Capability | Notes |
|------------|--------|
| Auth | Email + password, JWT, roles `buyer`, `seller`, `admin`; email OTP verify (SMTP optional, dev logs OTP). |
| Buyer | Local **catalog** (city/region), **cart**, **post request**, **list requests**, **view quotes per request**, **place order from quote** (`POST /api/orders` with `quote_id`). |
| Shopkeeper | **Products CRUD**, **open requests** in area/categories, **quotes**, **orders** tab; listings UI. |
| Static marketing | `public/index.html` — landing; **blue UI** aligned to mocks. |
| Deploy | Express + `api/index.js` for Vercel; env via `.env.example` / `npm run setup`. |

## Phase 2 (near-term, still “marketplace core”)

- **Payments UX** after quote-order: Razorpay checkout + webhook already in API — wire buttons + status in dashboards.
- **Buyer “saved” / profile** — mocks show sidebar items; needs endpoints or local-only MVP.
- **Shopkeeper quote composer** inline from Live tab (form → `POST /api/quotes`).
- **Forgot password** + optional **OTP login** (new endpoints + UI).

## Phase 3 (ops / enterprise from mocks — not in DB yet)

Each needs **data model + APIs + pages** (do not pretend exists today):

- Delivery / partners / RTO / maps
- Disputes & refunds workflow
- City manager / localities / coverage heatmaps
- Field sales pipeline & incentives
- Quality & compliance (KYC states, document review)
- Notifications centre + alert rules
- Analytics warehouse (GMV, funnel, cohorts)
- Team portal (Sales/Ops roles, 2FA)

## UI north star

- **Blue primary** (`blue-600`–`blue-950`), white surfaces, Inter/Mulish-style sans — see `public/login.html`, `public/index.html`, `public/UserDashboard.html`, `public/ShopkeeperDashboard.html`.
- Rich buyer dashboard: sidebar + KPIs + **request → quotes → choose → order** + browse + basket (implemented in `public/UserDashboard.html`).

## How to test the quote loop

1. **Buyer A** (city/region set): post a request in category X.  
2. **Seller B** (same city/region, category includes X): `POST /api/quotes` with `request_id`, `price`, etc.  
3. **Buyer A**: open dashboard → select request → see quotes → **Choose** → order created (`paymentStatus: pending` until payments wired).
