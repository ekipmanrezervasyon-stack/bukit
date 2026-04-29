-- Persist checkout/hand-over PDF links for admin history.

alter table if exists public.equipment_reservations
  add column if not exists pdf_url text,
  add column if not exists checkout_pdf_url text,
  add column if not exists archive_url text,
  add column if not exists pdf_archive_url text;

alter table if exists public.studio_reservations
  add column if not exists pdf_url text,
  add column if not exists studio_usage_form_url text,
  add column if not exists checkout_pdf_url text,
  add column if not exists archive_url text,
  add column if not exists pdf_archive_url text;
