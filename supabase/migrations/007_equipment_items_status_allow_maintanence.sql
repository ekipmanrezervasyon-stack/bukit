-- Allow legacy spelling MAINTANENCE in equipment_items.status.
-- Also keep common operational states used by admin UI.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'equipment_items_status_check'
  ) THEN
    ALTER TABLE public.equipment_items
      DROP CONSTRAINT equipment_items_status_check;
  END IF;
END $$;

ALTER TABLE public.equipment_items
  ADD CONSTRAINT equipment_items_status_check
  CHECK (
    status IS NOT NULL
    AND upper(status) IN (
      'AVAILABLE',
      'IN_USE',
      'BROKEN',
      'MAINTENANCE',
      'MAINTANENCE',
      'DAMAGED',
      'DELETED',
      'HIDDEN',
      'RESERVED',
      'REZERVE',
      'OVERDUE',
      'TAKEN'
    )
  );

