# bookdeck-api

Fastify + Supabase service skeleton for BookDeck (Supabase-only flow).

## Setup

1. Copy env template:

```bash
cp .env.example .env
```

2. Fill `.env`:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SESSION_SECRET` (strong random string; do not reuse service role key)
- `HEALTH_DEBUG_SECRET` (required to access `/api/health/supabase*` in production)
- `OTP_DEV_BYPASS` (`false` for live, `true` only for local testing)
- `RESEND_API_KEY`
- `OTP_EMAIL_FROM` (must be verified in Resend)
- Optional: `OTP_EMAIL_REPLY_TO`, `OTP_APP_NAME`

3. Run:

```bash
npm run dev
```

## Endpoints

- `GET /api/health`
- `GET /api/health/supabase`
- `GET /api/health/supabase/raw`
- `GET /api/studios`
- `GET /api/studio-reservations`
- `GET /api/equipment-items`
- `GET /api/equipment-reservations`
- `POST /api/auth/otp/request`
- `POST /api/auth/otp/verify`
- `GET /api/auth/session`
- `POST /api/auth/onboarding/student`
- `POST /api/auth/onboarding/staff`

## Notes

- This is the starting skeleton.
- Next step: OTP + onboarding + role guard + reservation create/approve flow.
- For live OTP email delivery:
  - Keep `OTP_DEV_BYPASS=false`.
  - Set `RESEND_API_KEY` and `OTP_EMAIL_FROM` (verified sender/domain in Resend).
  - API now fails fast at startup if mail delivery config is missing while bypass is disabled.
- In production:
  - Keep `NODE_ENV=production`.
  - Set a strict `CORS_ORIGIN` list.
  - Rotate secrets if `.env` was ever committed.
