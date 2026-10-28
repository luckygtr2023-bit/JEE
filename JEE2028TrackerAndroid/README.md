# JEE 2028 Tracker — Android app + self-hosted API

The supplied archive has been extracted here. It contains the original offline tracker UI, Android WebView shell, and home-screen widget. This project keeps the tracker usable without an account, and adds an optional self-hosted account, Google OAuth 2.0 (authorization-code flow with PKCE), and per-account cloud sync.

## What is included

- **Android app:** bundled tracker HTML, localStorage-based offline tracking, home-screen widget, account/sync screen, Google OAuth app-link callback.
- **Backend API:** zero-dependency Node.js service in `backend/` with password registration/login, signed 24-hour bearer sessions, sign-out/revocation, Google OpenID Connect sign-in, and user-scoped tracker sync.
- **Safety basics:** PBKDF2-SHA256 password hashes, short-lived one-use OAuth exchange codes, PKCE/state validation, request-size limits, throttling, no cookies, and atomic JSON store writes.
- **Deploy files:** `backend/Dockerfile`, `backend/compose.yaml`, and `backend/.env.example`.

The Android package does not launch a public internet server on the student's device. The API is the app's separately hosted companion service: deploy it on a server you control and point the app to it. Local tracker data remains available if that API is offline.

## Run the API

### Node.js directly

Requires Node.js 20 or newer; no npm packages are required.

```sh
cd backend
cp .env.example .env
# Set JWT_SECRET to a random secret of at least 32 characters.
# In production also configure HTTPS at a reverse proxy and set GOOGLE_* as needed.
set -a; . ./.env; set +a
node server.js
```

Check `GET /health`. The JSON data store is written to `backend/data/store.json` by default. Keep that directory backed up and private. This single-process JSON store is intended for a small, single-instance deployment; use a real database before running multiple API replicas or serving significant traffic.

### Docker Compose

From `backend/`, set `JWT_SECRET` in the deployment environment (and optional Google OAuth variables), then run `docker compose up -d --build`. The default host binding is loopback so a TLS reverse proxy can reach it locally. Do not expose the API publicly over plain HTTP.

### Google OAuth setup

Google sign-in is optional. In Google Cloud Console, configure an OAuth web client and register the exact HTTPS API callback URL, for example `https://api.your-domain.example/auth/google/callback`. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` in the backend environment. Keep the client secret and JWT secret on the server only. If these settings are absent, email/password sign-in still works and Google sign-in reports that it is not configured.

## Connect the Android app

Open **Sign in** in the app, enter the API's HTTPS origin (for example `https://api.your-domain.example`), then save/test it. Create an account or sign in. Google sign-in returns through the `jee2028://oauth/callback` Android deep link. Passwords are only sent to the configured API and should be used only with an HTTPS endpoint.

The tracker UI and widget work offline. When signed in and connected, edits are synced to the API; local and server checkmarks are union-merged so concurrent device edits are not silently discarded. The API stores user records separately. This merge strategy intentionally favors retaining completed ticks; resets/deletions made on one device do not currently act as cloud tombstones.

## Build an installable APK

Open `JEE2028TrackerAndroid/` in Android Studio, install Android SDK Platform 35 / Build Tools if prompted, and build the `app` debug variant (**Build → Build APK(s)**). The debug APK is for development/testing only. For distribution, create and protect your own release signing key and build a signed release APK/AAB. Do not use any debug keystore from the supplied archive as a production key.

## API routes

- `GET /health`
- `POST /api/auth/register` — `{ name, email, password }`
- `POST /api/auth/login` — `{ email, password }`
- `POST /api/auth/google/start` and `POST /api/auth/google/exchange` — OAuth + PKCE
- `GET /api/auth/me`, `POST /api/auth/logout`
- `GET /api/data`, `PUT /api/data` — authenticated, user-scoped tracker state

Sessions expire after 24 hours; users sign in again after expiration. On Android, the bearer token is encrypted at rest with an AES-GCM key held by Android Keystore; the user profile and tracker data remain in app-local storage. Back up the API data volume and rotate secrets carefully. The sample API does not implement password reset, email verification, refresh tokens, or a database migration system.
