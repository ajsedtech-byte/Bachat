# DigiLocker / Meri Pehchaan (Bachat)

This document describes how to **register as a partner**, configure **environment variables**, and use Bachat’s **OAuth + issued-document metadata** flow for **delivery partners** and **shopkeepers** (seller KYC).

Official ecosystem: [DigiLocker / Meri Pehchaan](https://digilocker.meripehchaan.gov.in/) · Partner onboarding: [Meri Pehchaan partner portal](https://dlpartners.meripehchaan.gov.in/).

---

## Step-by-step: what you do (portal → Bachat)

Portal UI may change; follow what you actually see on [dlpartners.meripehchaan.gov.in](https://dlpartners.meripehchaan.gov.in/). Use **FAQ’s** and support links on that site for timelines and required documents.

### Part A — Partner portal (Government / MeitY process)

1. **Open** [https://dlpartners.meripehchaan.gov.in](https://dlpartners.meripehchaan.gov.in) (DigiLocker & Meri Pehchaan partner site).
2. If you **already have** a partner account, click **Login** (top right) and sign in. If not, click **GET STARTED** and follow the portal’s **registration / organisation onboarding** (company details, authorised signatory, purpose of integration, etc.).
3. Complete any **verification or approval** steps the portal asks for (this phase is **outside Bachat** — timelines depend on the portal and your entity type).
4. In the partner dashboard, find the section for **OAuth / API / Application** (names vary). **Create an application** (or “OAuth client”) for your Bachat backend.
5. **Copy and store securely**:
   - **Client ID**
   - **Client Secret** (shown once on some portals — save it immediately).
6. **Register redirect URL(s)** in that same application. Add **exactly** (Bachat callback):

   - Local: `http://localhost:3000/api/digilocker/callback`
   - Production: `https://YOUR-API-DOMAIN/api/digilocker/callback`

   The string must match **character-for-character** what you put in `DIGILOCKER_REDIRECT_URI` later (including `http` vs `https`, port `:3000`, no extra slash).
7. Note which **scopes** the portal allows for your app. Bachat defaults to `openid` unless you set `DIGILOCKER_OAUTH_SCOPE` differently (see below).
8. **Save / submit** the application if the portal requires it and wait until the app is **approved / active** (if their workflow has a review state).

### Part B — Your Bachat server

9. On the machine where Bachat runs, edit **`.env`** (copy from `.env.example` if needed) and set:

   ```env
   DIGILOCKER_CLIENT_ID=paste_from_portal
   DIGILOCKER_CLIENT_SECRET=paste_from_portal
   DIGILOCKER_REDIRECT_URI=http://localhost:3000/api/digilocker/callback
   ```

   For production, use your real **HTTPS** URL for both the portal registration and `DIGILOCKER_REDIRECT_URI`.

10. **Restart** the Node process (`npm run dev` or your process manager) so env vars load.
11. **Check** in a browser or with curl: `GET http://localhost:3000/api/digilocker/status` → JSON should show `"enabled": true` when all three variables are set.

### Part C — Test with a real user

12. **Sign up / log in** as a **delivery** user (`delivery-kyc.html`) or **seller** (`seller-kyc.html`, direct verification path).
13. Click **Continue with DigiLocker**. You should be sent to the **government login** page, then back to Bachat at `delivery-kyc.html?digilocker=1` or `seller-kyc.html?digilocker=1`.
14. The page should call **pull issued metadata**; in MongoDB, `digilockerLinkedAt` / issued items should update for that user or seller.
15. If something fails, see **Troubleshooting** below and the portal **FAQ’s**.

---

## What Bachat implements

| Piece | Details |
|--------|--------|
| OAuth 2.0 | Authorization code flow: `GET` authorize URL → user signs in at DigiLocker → redirect to **your** callback with `code` + `state`. |
| Callback | `GET /api/digilocker/callback` — exchanges `code` for **access token** (short-lived, **not** stored in MongoDB; kept in **server memory** only for that session). |
| After login | Browser calls `POST /api/digilocker/pull-issued-meta` (Bearer from memory) to sync **issued document list metadata** (title, issuer, type, dates — **no file bodies** by default). |
| Persistence | **Delivery:** `User.deliveryKyc.digilockerLinkedAt`, `digilockerIssuedSyncedAt`, `digilockerIssuedItems`. **Seller:** same fields under `Seller.sellerKyc.*`. |
| File/XML download | **Off** unless `DIGILOCKER_ALLOW_FILE_FETCH=1` (high sensitivity — legal sign-off required). |

Code references: `src/lib/digilocker.js`, `src/routes/digilocker.js`, `public/delivery-kyc.html`, `public/seller-kyc.html`.

> Portal wording and steps change over time — follow the **current** partner documentation and support channels on the official site.

---

## 1. Environment variables (`.env`)

| Variable | Required | Purpose |
|----------|----------|---------|
| `DIGILOCKER_CLIENT_ID` | Yes* | OAuth client id from the partner portal. |
| `DIGILOCKER_CLIENT_SECRET` | Yes* | OAuth client secret. |
| `DIGILOCKER_REDIRECT_URI` | Yes* | **Exact** registered redirect URL, e.g. `http://localhost:3000/api/digilocker/callback`. |
| `DIGILOCKER_OAUTH_SCOPE` | No | Sent to `/authorize`. Default: `openid`. Set to empty string `DIGILOCKER_OAUTH_SCOPE=` to **omit** the scope query param (only if your portal requires that). |
| `DIGILOCKER_ALLOW_FILE_FETCH` | No | Set to `1` to allow `POST /api/digilocker/file` (PDF/XML). **Default off** — requires legal/data retention approval. |
| `DIGILOCKER_FETCH_MAX_BYTES` | No | Max bytes for file/XML download (default `2097152`). |

\*When all three of `CLIENT_ID`, `CLIENT_SECRET`, and `REDIRECT_URI` are set, `GET /api/digilocker/status` returns `enabled: true` and the **Continue with DigiLocker** button appears on:

- `delivery-kyc.html` (role `delivery`)
- `seller-kyc.html` direct verification path (role `seller`)

---

## 2. End-user flow (same for delivery and seller)

1. User is logged in (JWT) as `delivery` or `seller`.
2. User clicks **Continue with DigiLocker** → `POST /api/digilocker/authorize-url` → browser redirects to DigiLocker login.
3. User approves consent at DigiLocker → redirect to **`/api/digilocker/callback?code=...&state=...`**.
4. Server exchanges code, sets `digilockerLinkedAt`, stores short-lived access token in memory, redirects to:
   - **Delivery:** `/delivery-kyc.html?digilocker=1`
   - **Seller:** `/seller-kyc.html?digilocker=1`
5. Page runs `POST /api/digilocker/pull-issued-meta` → issued list saved on the user/seller record (metadata only).

---

## 3. API endpoints (reference)

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| `GET` | `/api/digilocker/status` | Public | Whether DigiLocker env is configured; file fetch flag. |
| `POST` | `/api/digilocker/authorize-url` | `delivery` or `seller` | Returns `{ authorize_url, state }`. |
| `GET` | `/api/digilocker/callback` | Browser redirect | OAuth callback (no JWT — uses `state`). |
| `POST` | `/api/digilocker/pull-issued-meta` | `delivery` or `seller` | Sync issued-doc metadata (needs recent OAuth session). |
| `POST` | `/api/digilocker/file` | `delivery` or `seller` | Optional file/XML download if `DIGILOCKER_ALLOW_FILE_FETCH=1`. |
| `POST` | `/api/digilocker/session/revoke` | `delivery` or `seller` | Clears in-memory access token. |

---

## 4. Local development checklist

- [ ] MongoDB + `JWT_SECRET` + app running (`npm run dev`).
- [ ] `.env` has the three `DIGILOCKER_*` variables; redirect is **`http://localhost:3000/api/digilocker/callback`** and is **registered identically** on the partner portal.
- [ ] Test with a **real** DigiLocker test user if the portal provides sandbox instructions.
- [ ] After linking, confirm `pull-issued-meta` returns `count` and DB shows `digilockerIssuedSyncedAt` / items (URIs are **not** exposed to the browser in list APIs — server only).

---

## 5. Production checklist

- [ ] HTTPS everywhere; redirect URI is **https** and matches portal config.
- [ ] Secrets only in env / secret manager — never committed.
- [ ] Privacy policy and consent copy mention DigiLocker and data use (coordinate with counsel).
- [ ] Decide if **metadata only** is enough for your KYC policy, or if you need file fetch (`DIGILOCKER_ALLOW_FILE_FETCH`) with retention controls.
- [ ] Ops workflow: sellers still may need **admin approval** on `/admin-seller-kyc.html` unless you change product rules.

---

## 6. Troubleshooting

| Symptom | Things to check |
|---------|------------------|
| “DigiLocker is not configured” | All three env vars set; server restarted after `.env` change. |
| `invalid_grant` / token error | `DIGILOCKER_REDIRECT_URI` must **exactly** match the redirect used in the authorize request and portal registration. |
| “No active DigiLocker session” on pull | User must complete OAuth and call `pull-issued-meta` **within** the short token lifetime; use **Continue with DigiLocker** again if expired. |
| Seller button missing | User must be **seller** and on **direct** KYC path; `GET /api/digilocker/status` must show `enabled: true`. |

---

## 7. What this is *not*

- **Not** a substitute for full **UIDAI OTP/XML eKYC** as a first-party app — that requires a **UIDAI-licensed ASP** if you need that specific modality.
- **Not** automatic “verified seller” — Bachat can still require **manual** `admin-seller-kyc` approval unless you change that logic.

For delivery-only context, see also `docs/DELIVERY-KYC.md`.
