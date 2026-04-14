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
