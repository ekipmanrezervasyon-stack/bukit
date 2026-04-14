-- Supabase-only completion migration
-- Adds missing tables for API routes:
--   - /api/tickets
--   - /api/contact/messages
--   - /api/equipment-notify/subscribe
--   - /api/admin/contact-messages*
--   - /api/admin/tickets*

-- 1) Equipment notify subscriptions
CREATE TABLE IF NOT EXISTS public.equipment_notify_subscriptions (
  id                text PRIMARY KEY,
  email             text NOT NULL,
  group_key         text NOT NULL,
  label             text,
  notified_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eq_notify_email_group
  ON public.equipment_notify_subscriptions (lower(email), group_key);

ALTER TABLE public.equipment_notify_subscriptions ENABLE ROW LEVEL SECURITY;

-- 2) Contact messages (new canonical table)
CREATE TABLE IF NOT EXISTS public.contact_messages (
  id                  text PRIMARY KEY,
  reservation_ref     text NOT NULL,
  requester_profile_id text,
  requester_email     text,
  requester_name      text,
  message             text NOT NULL,
  status              text NOT NULL DEFAULT 'new',
  admin_reply         text,
  reviewed_by         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_messages_created
  ON public.contact_messages (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_messages_res_ref
  ON public.contact_messages (reservation_ref);

ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;

-- 3) Extend legacy tickets table for new API admin fields
CREATE TABLE IF NOT EXISTS public.tickets (
  ticket_no           text PRIMARY KEY,
  created_at          timestamptz DEFAULT now(),
  name                text,
  email               text,
  phone_ext           text,
  department          text,
  staff_type          text,
  request_type        text,
  use_date            text,
  description         text,
  status              text,
  ticket_type         text,
  start_dt            timestamptz,
  end_dt              timestamptz,
  location            text
);

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS requester_profile_id text,
  ADD COLUMN IF NOT EXISTS requester_email text,
  ADD COLUMN IF NOT EXISTS requester_name text,
  ADD COLUMN IF NOT EXISTS admin_note text,
  ADD COLUMN IF NOT EXISTS reviewed_by text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_tickets_created_at
  ON public.tickets (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tickets_status
  ON public.tickets (status);

-- 4) Extend legacy bize_contact table for admin reply metadata compatibility
CREATE TABLE IF NOT EXISTS public.bize_contact (
  id                  text PRIMARY KEY,
  created_at          timestamptz DEFAULT now(),
  user_id             text,
  user_name           text,
  user_email          text,
  reservation_ref     text,
  message             text,
  status              text,
  admin_reply         text,
  updated_at          timestamptz DEFAULT now()
);

ALTER TABLE public.bize_contact
  ADD COLUMN IF NOT EXISTS reviewed_by text;

CREATE INDEX IF NOT EXISTS idx_bize_contact_created_at
  ON public.bize_contact (created_at DESC);

