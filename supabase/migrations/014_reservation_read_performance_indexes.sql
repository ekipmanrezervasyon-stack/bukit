-- Speed up reservation read paths without deleting or rewriting data.
-- These indexes target admin traffic, availability/conflict checks, calendar ranges,
-- and user/admin active reservation lookups.

create index if not exists idx_equipment_reservations_status_start_at
  on public.equipment_reservations (status, start_at);

create index if not exists idx_equipment_reservations_status_end_at
  on public.equipment_reservations (status, end_at);

create index if not exists idx_equipment_reservations_item_status_start_end
  on public.equipment_reservations (equipment_item_id, status, start_at, end_at);

create index if not exists idx_equipment_reservations_profile_status_end_at
  on public.equipment_reservations (requester_profile_id, status, end_at);

create index if not exists idx_equipment_reservations_email_status_end_at
  on public.equipment_reservations (requester_email, status, end_at);

create index if not exists idx_studio_reservations_status_start_at
  on public.studio_reservations (status, start_at);

create index if not exists idx_studio_reservations_status_end_at
  on public.studio_reservations (status, end_at);

create index if not exists idx_studio_reservations_studio_status_start_end
  on public.studio_reservations (studio_id, status, start_at, end_at);

create index if not exists idx_studio_reservations_profile_status_end_at
  on public.studio_reservations (requester_profile_id, status, end_at);

create index if not exists idx_studio_reservations_email_status_end_at
  on public.studio_reservations (requester_email, status, end_at);

create index if not exists idx_profiles_email
  on public.profiles (email);

create index if not exists idx_equipment_items_status_name
  on public.equipment_items (status, name);

create index if not exists idx_studios_name
  on public.studios (name);
