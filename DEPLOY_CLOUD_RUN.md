# Cloud Run Deployment

Recommended production target:

- Cloud Run for the web service
- Cloud SQL for PostgreSQL for persistent data
- Secret Manager for `LUMATRACK_SECRET_KEY` and OAuth secrets
- Custom domain over HTTPS
- Cloud Armor in front of the service for edge rate limiting and WAF controls

## Required environment

Set these on the Cloud Run service:

```text
LUMATRACK_PUBLIC_BASE_URL=https://app.example.com
LUMATRACK_ALLOWED_HOSTS=app.example.com
LUMATRACK_TRUST_PROXY=true
LUMATRACK_SESSION_COOKIE_SECURE=true
LUMATRACK_MAX_CONTENT_LENGTH=1048576
LUMATRACK_MIN_PASSWORD_LENGTH=12
DATABASE_URL=postgresql://USER:PASSWORD@/DBNAME?host=/cloudsql/PROJECT:REGION:INSTANCE
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
FACEBOOK_CLIENT_ID=...
FACEBOOK_CLIENT_SECRET=...
APPLE_CLIENT_ID=...
```

Also provide either:

```text
APPLE_CLIENT_SECRET=...
```

or:

```text
APPLE_TEAM_ID=...
APPLE_KEY_ID=...
APPLE_PRIVATE_KEY=...
```

## Deploy

Example image build and deploy:

```bash
gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT_ID/lumatrack/lumatrack

gcloud run deploy lumatrack \
  --image REGION-docker.pkg.dev/PROJECT_ID/lumatrack/lumatrack \
  --region REGION \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --memory 1Gi \
  --cpu 1 \
  --set-env-vars LUMATRACK_PUBLIC_BASE_URL=https://app.example.com,LUMATRACK_ALLOWED_HOSTS=app.example.com,LUMATRACK_TRUST_PROXY=true,LUMATRACK_SESSION_COOKIE_SECURE=true,LUMATRACK_MIN_PASSWORD_LENGTH=12 \
  --set-secrets LUMATRACK_SECRET_KEY=lumatrack-secret:latest,GOOGLE_CLIENT_ID=google-client-id:latest,GOOGLE_CLIENT_SECRET=google-client-secret:latest,FACEBOOK_CLIENT_ID=facebook-client-id:latest,FACEBOOK_CLIENT_SECRET=facebook-client-secret:latest
```

Attach the Cloud SQL instance to the service and set `DATABASE_URL` accordingly.

## Provider callbacks

Register these exact callback URLs in the provider dashboards:

- `https://app.example.com/auth/callback/google`
- `https://app.example.com/auth/callback/facebook`
- `https://app.example.com/auth/callback/apple`
