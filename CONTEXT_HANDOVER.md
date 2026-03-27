# Watchnest Context Handover

Last updated: 2026-03-27

## Project

Watchnest is a universal-style personal tracking app for:

- movies
- shows
- books

It supports:

- local email/password accounts
- server-backed state in SQLite or PostgreSQL
- metadata search
- manual tracking
- browser auto-capture for supported OTT sites
- Plex/Tautulli ingest
- optional OAuth providers
- Render deployment

## Repo And Deploy Targets

- Local repo path: `D:\Code\auto_movie_show_tracker`
- GitHub remote: `https://github.com/ramsaijanapana/LumaTrack.git`
- Active branch: `master`
- Latest pushed commit at handover time: `a3a12fc` (`Simplify Watchnest setup page`)
- Render app URL: `https://lumatrack-web.onrender.com/`

Important:

- The Render blueprint is set to manual sync.
- After any future push, Render still needs a manual sync to publish the change.

## Current Local-Only Work Not Yet Pushed

There are uncommitted local changes in:

- `app.js`
- `seed.js`
- `server.py`
- `styles.css`

These local changes include the current WIP/product polish beyond commit `a3a12fc`, including:

- compact library and queue UI improvements
- tighter watchlist cards and side search layout
- book tracking as a first-class content type
- Open Library metadata search for books
- book cover support through the image proxy
- reading-progress updates such as `Chapter 3` / `Finished`
- book stats and reward badge support

If you want the exact same working state on another PC, context alone is not enough. You must also do one of these:

1. Commit and push the current local changes from this PC first.
2. Or copy the modified files from this PC:
   - `app.js`
   - `seed.js`
   - `server.py`
   - `styles.css`

## Important Non-Git Local Files

These are not in the repo and may need to be copied manually to continue smoothly on another PC:

- `.env`
- `lumatrack.db`

What they contain:

- `.env`
  - local secrets
  - OAuth credentials if configured
  - OMDb key if configured
- `lumatrack.db`
  - local users
  - saved library state
  - ingest tokens
  - local test accounts

If you do not copy `lumatrack.db`, the app will still work, but local users and saved state on this PC will not exist on the new PC.

## Local Run Instructions

From the repo root:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe server.py
```

Open:

- `http://127.0.0.1:5000/`

If the browser shows stale UI, do a hard refresh:

```text
Ctrl+Shift+R
```

## Local Test Accounts

These accounts only exist if the copied environment also includes the current `lumatrack.db`.

- General local tester
  - Email: `local-test-1774225599@watchnest.local`
  - Password: `WatchnestTest123!`
- Clean books tester
  - Email: `books-test@watchnest.local`
  - Password: `WatchnestBooks123!`

## Current Feature Status

### Working And Usable

- local account auth
- server-backed library state
- show metadata via TVMaze
- movie metadata via Wikidata-backed lookup
- book metadata via Open Library
- manual add/edit/delete
- manual progress updates
- compact watchlist and queue layout
- theme switching
- optional ratings via OMDb when `OMDB_API_KEY` is configured
- browser auto-capture for Netflix, Prime Video, Disney+, Max, Apple TV+, and Plex web playback
- Plex webhook ingest
- Tautulli webhook ingest
- snapshot import/export and linked-file sync

### OAuth Status

Google, Facebook, and Apple login routes are implemented, but they only work when credentials are configured in `.env` or the host environment.

Required hosted callback URLs for the current Render URL:

- Google: `https://lumatrack-web.onrender.com/auth/callback/google`
- Facebook: `https://lumatrack-web.onrender.com/auth/callback/facebook`
- Apple: `https://lumatrack-web.onrender.com/auth/callback/apple`

## Books Work Added Locally

Books are now supported across the main app flow.

Behavior:

- search with `Books only`
- add a book directly from metadata search
- show author/year in results and library cards
- show Open Library rating when available
- update reading progress manually
- use progress labels like:
  - `Chapter 1`
  - `Chapter 3`
  - `Finished`
- show books in library filters, queue, stats, and rewards

Backend/source details:

- Book metadata source: Open Library search
- Book covers: proxied through `/api/image`

## What Was Verified Most Recently

Verified locally in a real browser session:

- register a new account
- search `the hobbit` with `Books only`
- cover image loads
- add `The Hobbit`
- filter library to books
- update progress to `Chapter 3`
- confirm queue entry exists
- confirm `Open` launches Open Library

Verified locally through the backend:

- `/api/bootstrap`
- authenticated metadata search
- image proxy response for Open Library covers

## Known Limitations

- The current book work is local only until committed/pushed.
- IMDb / Rotten Tomatoes / Metacritic ratings still depend on `OMDB_API_KEY`.
- OTT native mobile/TV playback cannot be tracked through official public APIs in the same way as browser playback.
- Render free-tier behavior still applies:
  - service spin-down on idle
  - ephemeral local disk
  - free Postgres limits from Render

## Best Next Step On Another PC

If the goal is to continue exactly where this machine left off:

1. Clone the repo.
2. Copy `.env`.
3. Copy `lumatrack.db` if you want existing users/state.
4. Bring over the uncommitted file changes, or push them first from this PC.
5. Start the server locally and verify the UI at `http://127.0.0.1:5000/`.

If the goal is to continue from GitHub only:

1. Clone the repo.
2. Checkout `master`.
3. Copy `.env`.
4. Start from pushed commit `a3a12fc`.
5. Re-implement or cherry-pick the local-only books/UI work from this handover.

## Files Most Relevant For Continuation

- `README.md`
- `.env.example`
- `server.py`
- `app.js`
- `seed.js`
- `styles.css`
- `render.yaml`
- `DEPLOY_RENDER.md`
- `extension\manifest.json`

