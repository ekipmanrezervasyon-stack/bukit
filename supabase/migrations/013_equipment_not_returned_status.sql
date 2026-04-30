-- Allow equipment reservations to remain explicitly unresolved when an item was not physically returned.
-- NOT VALID avoids scanning the live table during deploy; the constraint is still enforced for new/updated rows.

alter table if exists public.equipment_reservations
  drop constraint if exists equipment_reservations_status_check;

alter table if exists public.equipment_reservations
  add constraint equipment_reservations_status_check
  check (
    status is null
    or status in (
      'pending',
      'approved',
      'rejected',
      'cancelled',
      'CANCELLED',
      'completed',
      'COMPLETED',
      'returned',
      'RETURNED',
      'IN_USE',
      'in_use',
      'checked_out',
      'picked_up',
      'key_out',
      'not_returned'
    )
  ) not valid;
