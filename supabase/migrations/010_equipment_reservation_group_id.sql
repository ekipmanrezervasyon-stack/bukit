-- Group equipment reservations created by the same user in the same time window.
-- This enables "add to existing reservation window" flows and stable single-card rendering.

alter table if exists public.equipment_reservations
  add column if not exists reservation_group_id text;

with seeded as (
  select
    r.id,
    coalesce(
      nullif(r.reservation_group_id, ''),
      first_value(r.id) over (
        partition by
          coalesce(nullif(r.requester_profile_id::text, ''), lower(coalesce(r.requester_email, '')), r.id),
          r.start_at,
          r.end_at
        order by r.created_at nulls last, r.id
      )
    ) as gid
  from public.equipment_reservations r
)
update public.equipment_reservations t
set reservation_group_id = seeded.gid
from seeded
where t.id = seeded.id
  and coalesce(t.reservation_group_id, '') = '';

update public.equipment_reservations
set reservation_group_id = id
where coalesce(reservation_group_id, '') = '';

alter table public.equipment_reservations
  alter column reservation_group_id set not null;

create index if not exists idx_equipment_reservation_group_id
  on public.equipment_reservations (reservation_group_id);

create index if not exists idx_equipment_reservation_owner_window
  on public.equipment_reservations (requester_profile_id, requester_email, start_at, end_at, status);
