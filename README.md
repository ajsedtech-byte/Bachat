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

### Env vars

See `.env.example` for all options. **Never commit `.env`** — it is gitignored.

### Repo

Upstream: [github.com/ajsedtech-byte/Bachat](https://github.com/ajsedtech-byte/Bachat)
