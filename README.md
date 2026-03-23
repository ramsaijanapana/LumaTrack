# Watchnest

Watchnest is now a server-backed watch tracker instead of a browser-only prototype. It keeps per-user library state in SQLite, supports local account sign-in immediately, exposes OAuth hooks for Google/Facebook/Apple, and includes real ingest paths for browser auto-capture plus Plex/Tautulli playback events.

## What is usable now

- Local email/password accounts backed by SQLite
- Server-stored library, sessions, and connector state
- Real metadata search
- TV shows: TVMaze
- Movies: Wikidata-backed lookup
- Title add/edit/delete flows
- Manual progress logging plus manual watched-history entry
- Theme switching across the signed-in app
- Optional ratings enrichment on saved titles via OMDb
- Browser auto-capture for Netflix, Prime Video, Disney+, Max, Apple TV+, and Plex web tabs
- Plex webhook and Tautulli webhook ingest routes
- Token-based manual fallback plus a loadable browser extension popup
- Snapshot export/import and optional linked JSON file sync

## Production posture

The app now supports a safer hosted deployment posture:

- Production WSGI runtime via Gunicorn
- Optional PostgreSQL via `DATABASE_URL` for hosted persistence
- HTTPS-aware secure session cookies
- Optional proxy trust and host allow-listing
- CSRF protection for session-backed API calls
- Basic in-app rate limiting on auth, token, and ingest routes
- Security headers including CSP, HSTS, frame denial, and referrer policy

## What still needs provider configuration

Google, Facebook, and Apple login are implemented in the backend, but they only become clickable when their OAuth credentials are configured in `.env` or in the process environment.

The public product name is `Watchnest`. The deployment env vars still use the `LUMATRACK_*` prefix for compatibility with the existing setup.

That part is unavoidable. No web app can provide production OAuth sign-in for those providers without registered app credentials and redirect URIs.

## Run locally

1. Create and activate a virtual environment if you have not already.
2. Install the dependencies:

```powershell
.\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt
```

3. Copy `.env.example` to `.env` and fill in the values you want to enable.
4. Start the server:

```powershell
.\\.venv\\Scripts\\python.exe server.py
```

5. Open `http://127.0.0.1:5000`.

## Hosting as a web app

For a hosted deployment, do not run Flask's development server in production. Flask's docs recommend a production WSGI server or hosting platform instead.

- Deploy behind HTTPS on one stable origin such as `https://app.example.com`.
- Set `LUMATRACK_PUBLIC_BASE_URL=https://app.example.com`.
- Set `LUMATRACK_ALLOWED_HOSTS=app.example.com`.
- If your platform sits behind a reverse proxy or load balancer, set `LUMATRACK_TRUST_PROXY=true`.
- Prefer `DATABASE_URL` backed by PostgreSQL instead of local SQLite.
- Keep OAuth credentials in host-managed environment variables or a secret manager, not in source control.
- Register these exact callback URLs with the providers:
  - Google: `https://app.example.com/auth/callback/google`
  - Facebook: `https://app.example.com/auth/callback/facebook`
  - Apple: `https://app.example.com/auth/callback/apple`

For hosted HTTPS deployments, the app now sets secure session cookies automatically when `LUMATRACK_PUBLIC_BASE_URL` starts with `https://`. You can override that with `LUMATRACK_SESSION_COOKIE_SECURE=true|false` if needed.

Recommended production target:

- Cloud Run
- Cloud SQL for PostgreSQL
- Secret Manager
- Cloud Armor

Simplest free starting path:

- Render Blueprint with free web service + free Render Postgres
- See `DEPLOY_RENDER.md`

Deployment assets:

- `Dockerfile`
- `gunicorn.conf.py`
- `DEPLOY_CLOUD_RUN.md`
- `DEPLOY_RENDER.md`
- `render.yaml`

## OAuth provider setup

Use the callback URLs below when registering your app with each provider:

- Google: `http://127.0.0.1:5000/auth/callback/google`
- Facebook: `http://127.0.0.1:5000/auth/callback/facebook`
- Apple: `http://127.0.0.1:5000/auth/callback/apple`

Set the matching environment variables from `.env.example` before starting the server.

Provider notes:

- Google: set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- Facebook: set `FACEBOOK_CLIENT_ID` and `FACEBOOK_CLIENT_SECRET`.
- Apple: set `APPLE_CLIENT_ID` and then either:
  - provide `APPLE_CLIENT_SECRET`, or
  - provide `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY_PATH` or `APPLE_PRIVATE_KEY` so the server can generate the JWT client secret for you.
- If you deploy behind a proxy or a public domain, set `LUMATRACK_PUBLIC_BASE_URL` so the generated callback URL stays stable and matches the value registered with Google/Facebook/Apple.

The Apple callback route now accepts Apple's `form_post` response mode, and the server will merge the first-login name/email payload Apple returns.

Google and Facebook login are fully implemented in the app code. They become active as soon as the registered OAuth client ID and client secret are present in `.env`, and the callback URL shown on the sign-in screen is added to the provider app settings.

## Browser auto-capture extension

The browser companion in `extension/` now has two modes:

- Auto-capture on supported playback pages:
  - Netflix
  - Prime Video
  - Disney+
  - Max
  - Apple TV+
  - Plex web
- Manual fallback on any page when auto-capture is unavailable or metadata detection needs help

Setup:

1. Open your browser's extensions page.
2. Enable developer mode.
3. Load `extension/` as an unpacked extension.
4. In Watchnest, create an ingest token.
5. Paste the app URL and token into the extension popup and save.
6. Grant access to your Watchnest origin when the extension asks.
7. Open a supported playback page. The extension will post progress automatically in the background.
8. Use `Send manually` in the popup when a site is unsupported or detection needs correction.
9. If the tab was already open before you loaded or updated the extension, use the popup once or hit `Refresh` so the companion injects into that existing tab too.

Auto-capture posts to `POST /api/ingest/observation` with absolute progress so repeated updates do not keep inflating the same title.

## Themes and ratings

- Theme switching is built into the signed-in app and is stored with the user profile state.
- Ratings enrichment is optional and uses `OMDB_API_KEY`.
- When `OMDB_API_KEY` is present, Watchnest can attach IMDb, Rotten Tomatoes, and Metacritic ratings to saved titles.

## Plex and Tautulli

Use the same ingest token for either of these:

- Plex webhook URL:
  - `https://your-watchnest-host/api/integrations/plex/webhook?token=YOUR_TOKEN`
- Tautulli webhook URL:
  - `https://your-watchnest-host/api/integrations/tautulli/webhook?token=YOUR_TOKEN`

Supported Plex/Tautulli playback events are normalized into the same Watchnest timeline and connector state. Non-playback events are ignored safely.

## Storage model

- Primary source of truth: SQLite (`lumatrack.db`)
- Optional portability: exported snapshot JSON or linked sync file
- Ingest tokens are hashed before storage

## Files

- `server.py`: Flask app, auth, SQLite storage, metadata search, and ingest API
- `app.js`: browser app controller and authenticated UI
- `api.js`: frontend API client
- `extension/`: unpacked browser companion with background auto-capture
- `DEPLOY_CLOUD_RUN.md`: hosted deployment guide for Cloud Run
- `DEPLOY_RENDER.md`: simplest free hosted deployment path
