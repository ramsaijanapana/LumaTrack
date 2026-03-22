# Render Deployment

This is the simplest free starting path for getting LumaTrack online.

## What is already prepared

- `render.yaml` creates:
  - a free Python web service
  - a free Render Postgres database
- The app automatically supports:
  - `RENDER_EXTERNAL_URL` for callback and cookie base URL fallback
  - proxy-aware request handling
  - PostgreSQL through `DATABASE_URL`

## Deploy steps

1. Push this repo to GitHub, GitLab, or Bitbucket.
2. Create a Render account.
3. In Render, choose **New > Blueprint**.
4. Connect the repo and select the `render.yaml` blueprint.
5. Let Render create:
   - `lumatrack-web`
   - `lumatrack-db`
6. Wait for the first deploy to finish.
7. Open the generated app URL and create a local account.

## Add OAuth later

Once the service has a public Render URL, add these exact callback URLs to the provider dashboards:

- `https://YOUR-RENDER-URL/auth/callback/google`
- `https://YOUR-RENDER-URL/auth/callback/facebook`
- `https://YOUR-RENDER-URL/auth/callback/apple`

Then add the matching secrets in the Render dashboard:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `FACEBOOK_CLIENT_ID`
- `FACEBOOK_CLIENT_SECRET`
- Apple variables if needed

## Free-tier limits

Render's official docs currently state:

- Free web services spin down after 15 minutes of idle time.
- Free web services use an ephemeral filesystem, so local SQLite is not suitable.
- Free Postgres is limited to 1 GB and expires after 30 days.

This repo avoids the SQLite issue by using the Render Postgres `DATABASE_URL` automatically.
