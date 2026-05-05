# Bachat

Local marketplace-style flow: buyers post requests, shopkeepers quote, orders and cart backed by Express + MongoDB.

## Do-it-yourself (clone → run)

```bash
git clone https://github.com/ajsedtech-byte/Bachat.git
cd Bachat
npm install
npm run setup
```

Edit `.env` (created from `.env.example`): set **`MONGO_URI`** and **`JWT_SECRET`** at minimum. Then:

```bash
npm run dev
```

Open **http://localhost:3000** (or the port printed in the terminal). Static pages include `signup.html`, `login.html`, and dashboards.

### Useful commands

| Command | Purpose |
|--------|---------|
| `npm run setup` | Create `.env` from `.env.example` if missing |
| `npm run dev` | API + static files with auto-restart |
| `npm start` | Production-style start (no watch) |
| `npm run migrate` | Run DB migrations |
| `npm run create-admin` | Create or update one **admin** user (env / argv) |
| `npm run create-sales` | Create or update one **sales** user (env / argv) |
| `npm run sync-team` | Upsert **Admin + Ops + Sales** from `ADMIN_*`, `OPS_*`, `SALES_*` in `.env` |

### Env vars

See `.env.example` for all options. **Never commit `.env`** — it is gitignored.

### Production checklist (concise)

- Set **`NODE_ENV=production`**, strong **`JWT_SECRET`**, and managed **`MONGO_URI`**.
- Set **`CORS_ORIGIN`** to an explicit comma-separated allowlist of your HTTPS web origins (empty allow-all is unsafe in production).
- Terminate **TLS** at your host or reverse proxy; do not serve admin or login flows over plain HTTP.
- Configure **SMTP** so registration, login OTP, password reset, and phone-on-profile confirmation emails deliver.
- Set **Razorpay** keys when taking payments; configure webhook URL and secret.
- **Monitoring:** attach your platform’s health checks to `GET /health` and log aggregation for the Node process.
- Team UI: run **`npm run sync-team`** once (or after password changes), then sign in at **`/team-login.html`**: **Sales** → `admin-sales.html`; **Ops** and **Admin** → `AdminDashboard.html` (both use `role: admin`; use separate emails from `.env`).
- **Seller eKYC:** New shopkeepers verify at `/seller-kyc.html` (field visit or document upload). Approve or reject from **`/admin-seller-kyc.html`** (`GET/PATCH /api/admin/seller-kyc/*`). Approved sellers receive a completion email and full access to `ShopkeeperDashboard.html`.

### Docs

- `docs/MVP-ROADMAP.md` — product phases.
- `docs/PHASE3-STATUS.md` — what “Phase 3” modules exist vs planned.
- `docs/DELIVERY-KYC.md` — delivery identity / DigiLocker / UIDAI expectations.
- `docs/DIGILOCKER.md` — **DigiLocker / Meri Pehchaan** partner setup, env vars, flows (delivery + seller).

### Repo

Upstream: [github.com/ajsedtech-byte/Bachat](https://github.com/ajsedtech-byte/Bachat)
