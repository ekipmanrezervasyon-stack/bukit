# BUKit Go-Live Runbook

This runbook is the operational checklist for `bilgibooking.com`.

## Production URLs

- User: `https://bilgibooking.com/`
- Admin: `https://bilgibooking.com/admin/`
- API Health: `https://bukit-production.up.railway.app/api/health`

## Core Architecture

- Frontend: Cloudflare (custom domain: `bilgibooking.com`)
- Backend: Railway (`bukit-production.up.railway.app`)
- Database/Auth: Supabase

## Pre-Launch Checklist

- [ ] User URL opens without redirects/blank screen.
- [ ] Admin URL opens and role-gated pages are visible only to admin roles.
- [ ] Equipment/studio reservation create flow works.
- [ ] Official holiday lock works on both user/admin equipment flows.
- [ ] GREEN studio weekend availability works (except official holidays).
- [ ] Admin user lookup, history, pending, and reports panels load.
- [ ] Railway health endpoint returns `ok: true`.
- [ ] Supabase RLS policies reviewed for reservations + profiles tables.
- [ ] `SESSION_SECRET` set (32+ chars) in Railway.
- [ ] `SUPER_ADMIN_EMAIL_ALLOWLIST` set in Railway (comma-separated trusted emails).
- [ ] `HEALTH_DEBUG_SECRET` set in Railway.
- [ ] `SUPABASE_SERVICE_ROLE_KEY` and `RESEND_API_KEY` rotated after any git exposure.

## Soft Launch Procedure

1. Open access to a limited user group first.
2. Monitor logs for the first 24 hours.
3. Collect errors/screenshots from users.
4. Patch + deploy quickly if needed.
5. Expand to all users after stability.

## Daily Operations

- Check Railway logs for 5xx spikes and auth errors.
- Check critical admin tabs:
  - Pending approvals
  - User lookup
  - Studio calendar (week/month)
- Verify `api/health`.

## Secret Rotation Playbook (Supabase + Resend)

1. **Freeze risk window**
   - Pause admin operations for 10 minutes.
   - Keep one active maintainer online.
2. **Rotate Supabase service role key**
   - Supabase Dashboard → Project Settings → API/Keys.
   - Generate/rotate service-role credential.
   - Copy new key securely.
3. **Rotate Resend API key**
   - Resend Dashboard → API Keys.
   - Create a new key for production mail sending.
   - Keep old key only until smoke test finishes.
4. **Update Railway environment variables**
   - Set `SUPABASE_SERVICE_ROLE_KEY=<new>`.
   - Set `RESEND_API_KEY=<new>`.
   - Ensure `SESSION_SECRET` exists and is 32+ chars.
   - Ensure `SUPER_ADMIN_EMAIL_ALLOWLIST` exists (trusted emails only).
   - Ensure `HEALTH_DEBUG_SECRET` exists.
5. **Redeploy + smoke test**
   - Test OTP request + verify.
   - Test admin login.
   - Test one equipment checkout/checkin flow.
6. **Revoke old keys**
   - Delete old Resend API key.
   - Revoke old Supabase service-role credential (or complete key rotation procedure).
7. **Post-check**
   - Confirm `/api/health` returns `ok: true`.
   - Confirm non-allowlisted `super_admin` rows are not treated as super admin.

## Incident Playbook

### 1) Site opens but actions fail

1. Check browser console and network errors.
2. Verify API health endpoint.
3. Check Railway logs for 401/403/500.
4. Validate Supabase availability.

### 2) Admin says "session token required"

1. Log out and sign in again.
2. Verify token storage/expiry behavior.
3. Check `/auth/session` API response.
4. Check recent auth-related commits.

### 3) Reservations fail unexpectedly

1. Confirm selected range is not on official holidays.
2. Check overlap/conflict logic.
3. Check reservation endpoint logs and payloads.
4. Check Supabase table permissions (RLS).

## Rollback Procedure

1. Identify last stable commit from `main`.
2. Re-deploy that commit.
3. Re-test:
   - user homepage
   - admin login
   - create reservation flow
4. Keep incident notes with root cause and fix plan.

## Ownership

- Product owner: (fill)
- Technical owner: (fill)
- Emergency contact: (fill)

## Notes

- Keep admin URL private to authorized staff only.
- Public users should only receive user URL.
- Use this file as the single source for go-live ops.
