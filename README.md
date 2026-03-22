# LumaTrack

LumaTrack is now a server-backed watch tracker instead of a browser-only prototype. It keeps per-user library state in SQLite, supports local account sign-in immediately, exposes OAuth hooks for Google/Facebook/Apple, and includes a browser companion extension flow for ingesting watch observations.

## What is usable now

- Local email/password accounts backed by SQLite
- Server-stored library, sessions, and connector state
- Real metadata search
- TV shows: TVMaze
- Movies: Wikidata-backed lookup
- Title add/edit/delete flows
- Manual progress logging and unified activity timeline
- Companion token flow plus a loadable browser extension popup
- Snapshot export/import and optional linked JSON file sync

## What still needs provider configuration

Google, Facebook, and Apple login are implemented in the backend, but they only become clickable when their OAuth credentials are configured in the environment.

That part is unavoidable. No web app can provide production OAuth sign-in for those providers without registered app credentials and redirect URIs.

## Run locally

1. Create and activate a virtual environment if you have not already.
2. Install the dependencies:

```powershell
.\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt
```

3. Optionally set environment variables from `.env.example`.
4. Start the server:

```powershell
.\\.venv\\Scripts\\python.exe server.py
```

5. Open `http://127.0.0.1:5000`.

## OAuth provider setup

Use the callback URLs below when registering your app with each provider:

- Google: `http://127.0.0.1:5000/auth/callback/google`
- Facebook: `http://127.0.0.1:5000/auth/callback/facebook`
- Apple: `http://127.0.0.1:5000/auth/callback/apple`

Set the matching environment variables from `.env.example` before starting the server.

## Browser companion extension

The first real ingestion path lives in the `extension/` folder.

1. Open your browser's extensions page.
2. Enable developer mode.
3. Load `extension/` as an unpacked extension.
4. In LumaTrack, create a companion token.
5. Paste the app URL and token into the extension popup.
6. Open a streaming page and click `Send observation`.

That observation is posted to `POST /api/ingest/observation` and merged into your account.

## Storage model

- Primary source of truth: SQLite (`lumatrack.db`)
- Optional portability: exported snapshot JSON or linked sync file
- Companion tokens are hashed before storage

## Files

- `server.py`: Flask app, auth, SQLite storage, metadata search, and ingest API
- `app.js`: browser app controller and authenticated UI
- `api.js`: frontend API client
- `extension/`: unpacked browser companion
