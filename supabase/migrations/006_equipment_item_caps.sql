-- Per-item reservation cap support (e.g. SOUND category overall 3, specific models max 1).

ALTER TABLE public.equipment_items
  ADD COLUMN IF NOT EXISTS eq_max_per_reservation integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'equipment_items_eq_max_per_reservation_chk'
  ) THEN
    ALTER TABLE public.equipment_items
      ADD CONSTRAINT equipment_items_eq_max_per_reservation_chk
      CHECK (eq_max_per_reservation IS NULL OR eq_max_per_reservation >= 1);
  END IF;
END $$;

