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
| `npm run create-admin` | Create admin user (see script / env vars) |
| `npm run create-sales` | Create **sales** role user for field leads (`admin-sales.html`) |

### Env vars

See `.env.example` for all options. **Never commit `.env`** — it is gitignored.

### Production checklist (concise)

- Set **`NODE_ENV=production`**, strong **`JWT_SECRET`**, and managed **`MONGO_URI`**.
- Set **`CORS_ORIGIN`** to an explicit comma-separated allowlist of your HTTPS web origins (empty allow-all is unsafe in production).
- Terminate **TLS** at your host or reverse proxy; do not serve admin or login flows over plain HTTP.
- Configure **SMTP** so registration, login OTP, password reset, and phone-on-profile confirmation emails deliver.
- Set **Razorpay** keys when taking payments; configure webhook URL and secret.
- **Monitoring:** attach your platform’s health checks to `GET /health` and log aggregation for the Node process.
- Ops UI: sign in as **`admin`** (see `npm run create-admin`) at `/team-login.html` (Operations), then open `/AdminDashboard.html` and linked `admin-*.html` pages. Field sales uses **`npm run create-sales`** and the same team login (Field sales tab) → `/admin-sales.html`.

### Docs

- `docs/MVP-ROADMAP.md` — product phases.
- `docs/PHASE3-STATUS.md` — what “Phase 3” modules exist vs planned.
- `docs/DELIVERY-KYC.md` — delivery identity / DigiLocker / UIDAI expectations.

### Repo

Upstream: [github.com/ajsedtech-byte/Bachat](https://github.com/ajsedtech-byte/Bachat)
