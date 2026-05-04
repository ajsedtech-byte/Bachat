# DigiLocker / Meri Pehchaan (Bachat)

This document describes how to **register as a partner**, configure **environment variables**, and use Bachat’s **OAuth + issued-document metadata** flow for **delivery partners** and **shopkeepers** (seller KYC).

Official ecosystem: [DigiLocker / Meri Pehchaan](https://digilocker.meripehchaan.gov.in/) · Partner onboarding: [Meri Pehchaan partner portal](https://dlpartners.meripehchaan.gov.in/).

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

---

## 1. Partner registration (required for production)

1. Go to **[Meri Pehchaan / DigiLocker partner portal](https://dlpartners.meripehchaan.gov.in/)** and create or access your organisation’s application.
2. Complete their **KYC / verification** for your entity (varies by portal process).
3. Create an **OAuth client** and obtain:
   - **Client ID**
   - **Client Secret**
4. Register **Redirect URI(s)** — must match **exactly** (scheme, host, port, path, no trailing slash mismatch). For Bachat use **one** callback for all roles:

   `https://<your-api-domain>/api/digilocker/callback`  
   Local dev example: `http://localhost:3000/api/digilocker/callback`

5. Confirm **scopes** the portal allows. Bachat defaults to sending `scope=openid` unless you override (see `DIGILOCKER_OAUTH_SCOPE` below).

6. Use **HTTPS** in production for `PUBLIC_APP_URL`, your site, and the redirect URI.

> Portal wording and steps change over time — follow the **current** partner documentation and support channels on the official site.

---

## 2. Environment variables (`.env`)

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

## 3. End-user flow (same for delivery and seller)

1. User is logged in (JWT) as `delivery` or `seller`.
2. User clicks **Continue with DigiLocker** → `POST /api/digilocker/authorize-url` → browser redirects to DigiLocker login.
3. User approves consent at DigiLocker → redirect to **`/api/digilocker/callback?code=...&state=...`**.
4. Server exchanges code, sets `digilockerLinkedAt`, stores short-lived access token in memory, redirects to:
   - **Delivery:** `/delivery-kyc.html?digilocker=1`
   - **Seller:** `/seller-kyc.html?digilocker=1`
5. Page runs `POST /api/digilocker/pull-issued-meta` → issued list saved on the user/seller record (metadata only).

---

## 4. API endpoints (reference)

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| `GET` | `/api/digilocker/status` | Public | Whether DigiLocker env is configured; file fetch flag. |
| `POST` | `/api/digilocker/authorize-url` | `delivery` or `seller` | Returns `{ authorize_url, state }`. |
| `GET` | `/api/digilocker/callback` | Browser redirect | OAuth callback (no JWT — uses `state`). |
| `POST` | `/api/digilocker/pull-issued-meta` | `delivery` or `seller` | Sync issued-doc metadata (needs recent OAuth session). |
| `POST` | `/api/digilocker/file` | `delivery` or `seller` | Optional file/XML download if `DIGILOCKER_ALLOW_FILE_FETCH=1`. |
| `POST` | `/api/digilocker/session/revoke` | `delivery` or `seller` | Clears in-memory access token. |

---

## 5. Local development checklist

- [ ] MongoDB + `JWT_SECRET` + app running (`npm run dev`).
- [ ] `.env` has the three `DIGILOCKER_*` variables; redirect is **`http://localhost:3000/api/digilocker/callback`** and is **registered identically** on the partner portal.
- [ ] Test with a **real** DigiLocker test user if the portal provides sandbox instructions.
- [ ] After linking, confirm `pull-issued-meta` returns `count` and DB shows `digilockerIssuedSyncedAt` / items (URIs are **not** exposed to the browser in list APIs — server only).

---

## 6. Production checklist

- [ ] HTTPS everywhere; redirect URI is **https** and matches portal config.
- [ ] Secrets only in env / secret manager — never committed.
- [ ] Privacy policy and consent copy mention DigiLocker and data use (coordinate with counsel).
- [ ] Decide if **metadata only** is enough for your KYC policy, or if you need file fetch (`DIGILOCKER_ALLOW_FILE_FETCH`) with retention controls.
- [ ] Ops workflow: sellers still may need **admin approval** on `/admin-seller-kyc.html` unless you change product rules.

---

## 7. Troubleshooting

| Symptom | Things to check |
|---------|------------------|
| “DigiLocker is not configured” | All three env vars set; server restarted after `.env` change. |
| `invalid_grant` / token error | `DIGILOCKER_REDIRECT_URI` must **exactly** match the redirect used in the authorize request and portal registration. |
| “No active DigiLocker session” on pull | User must complete OAuth and call `pull-issued-meta` **within** the short token lifetime; use **Continue with DigiLocker** again if expired. |
| Seller button missing | User must be **seller** and on **direct** KYC path; `GET /api/digilocker/status` must show `enabled: true`. |

---

## 8. What this is *not*

- **Not** a substitute for full **UIDAI OTP/XML eKYC** as a first-party app — that requires a **UIDAI-licensed ASP** if you need that specific modality.
- **Not** automatic “verified seller” — Bachat can still require **manual** `admin-seller-kyc` approval unless you change that logic.

For delivery-only context, see also `docs/DELIVERY-KYC.md`.
