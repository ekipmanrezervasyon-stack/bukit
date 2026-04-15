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
