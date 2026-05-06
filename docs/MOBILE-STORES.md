# Bachat — Android (Play Store) & iOS (App Store)

The web UI in `public/` is wrapped with **[Capacitor](https://capacitorjs.com/)** so you can ship the same codebase as native store apps.

## How it works

1. **`npm run mobile:prepare`** copies `public/` → `www/` and writes `www/js/native-init.js` with your production API URL. In the native WebView, relative `/api/...` calls do not hit your server; the app sets `localStorage.bachat_api_base` so existing dashboard `fetchApi` logic uses your HTTPS backend.
2. **`npx cap sync`** copies `www/` into the Android/iOS projects.
3. You open **Android Studio** or **Xcode**, build release binaries, and upload to stores.

## One-time setup

1. Install dependencies (from repo root):

   ```bash
   npm install
   ```

2. Set your **public HTTPS** origin (no trailing slash) in `.env`:

   ```env
   MOBILE_API_BASE_URL=https://your-domain.com
   ```

   You can use the same value as `PUBLIC_APP_URL` if you already set that.

3. Generate `www/` and sync native projects:

   ```bash
   npm run mobile:prepare
   npx cap sync
   ```

4. **Android** (Windows/macOS/Linux):

   ```bash
   npm run mobile:open:android
   ```

   In Android Studio: **Build → Generate Signed Bundle / APK** for Play Console (AAB recommended).

5. **iOS** (requires **macOS** + **Xcode**):

   ```bash
   npm run mobile:open:ios
   ```

   Configure signing team, bump version, **Archive**, upload to App Store Connect.

## Play Store checklist (short)

- **Privacy policy** URL (required for apps that use location, accounts, etc.).
- **Data safety** form in Play Console.
- **App signing** with Google Play App Signing.
- **Target API level** — keep Capacitor/Android Gradle templates updated (`npx cap update`).
- Location: you use browser Geolocation; declare location in the store listing and privacy policy.

## App Store checklist (later)

- **Apple Developer Program** ($99/year).
- **Privacy “nutrition labels”** and location usage strings.
- In `ios/App/App/Info.plist`, ensure **NSLocationWhenInUseUsageDescription** (and any other keys Capacitor/plugins require) are set — Capacitor docs and Xcode will prompt when you add the Geolocation plugin if needed.

## Changing the app id / name

Edit `capacitor.config.json`:

- `appId`: reverse-DNS id, e.g. `in.bachat.app` (must match what you register in Play Console / Apple).
- `appName`: display name.

After changes:

```bash
npm run mobile:prepare
npx cap sync
```

## Remote URL mode (optional)

If you prefer the WebView to load your site directly (no bundled `www/`), you can set `server.url` in `capacitor.config.json` to your HTTPS URL and remove reliance on `native-init.js` for API base — useful if you never want to ship static updates via the store. For most teams, bundled `www/` + `MOBILE_API_BASE_URL` is simpler for offline shell and predictable caching.

## Troubleshooting

- **Blank screen / API errors:** Confirm `MOBILE_API_BASE_URL` is HTTPS, reachable from a phone, and CORS allows your app if you use cross-origin setups (same host as API avoids CORS for typical same-origin API paths when using full URL as base).
- **HTTP cleartext:** Avoid HTTP in production; Android cleartext is discouraged. Use HTTPS.
