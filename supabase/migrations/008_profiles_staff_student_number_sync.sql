-- Keep staff_number and student_number in sync for staff-like accounts.
-- Requirement: staff users should have STFxxxxxx visible in student_number-driven UIs as well.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS staff_number text,
  ADD COLUMN IF NOT EXISTS staff_auto_id text;

CREATE SEQUENCE IF NOT EXISTS public.profiles_staff_number_seq
  AS bigint
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1
  NO MAXVALUE
  CACHE 1;

DO $$
DECLARE
  v_max bigint;
BEGIN
  SELECT COALESCE(MAX((substring(staff_number from '^STF([0-9]+)$'))::bigint), 0)
    INTO v_max
  FROM public.profiles
  WHERE staff_number ~ '^STF[0-9]+$';

  PERFORM setval('public.profiles_staff_number_seq', GREATEST(v_max, 1), true);
END $$;

CREATE OR REPLACE FUNCTION public.assign_profile_staff_number()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (COALESCE(NEW.user_type, '') = 'staff' OR COALESCE(NEW.role, '') IN ('staff', 'instructor', 'super_admin', 'technician', 'iiw_instructor', 'iiw_admin')) THEN
    IF COALESCE(NULLIF(BTRIM(NEW.staff_number), ''), '') = '' THEN
      NEW.staff_number := 'STF' || LPAD(nextval('public.profiles_staff_number_seq')::text, 7, '0');
    END IF;
    NEW.staff_auto_id := NEW.staff_number;
    -- Staff rows must expose STF id in student_number-based flows.
    NEW.student_number := NEW.staff_number;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_profile_staff_number ON public.profiles;
CREATE TRIGGER trg_assign_profile_staff_number
BEFORE INSERT OR UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.assign_profile_staff_number();

WITH targets AS (
  SELECT id
  FROM public.profiles
  WHERE (COALESCE(user_type, '') = 'staff' OR COALESCE(role, '') IN ('staff', 'instructor', 'super_admin', 'technician', 'iiw_instructor', 'iiw_admin'))
    AND COALESCE(NULLIF(BTRIM(staff_number), ''), '') = ''
  ORDER BY created_at NULLS LAST, id
)
UPDATE public.profiles p
SET staff_number = 'STF' || LPAD(nextval('public.profiles_staff_number_seq')::text, 7, '0')
FROM targets t
WHERE p.id = t.id
  AND COALESCE(NULLIF(BTRIM(p.staff_number), ''), '') = '';

UPDATE public.profiles
SET staff_auto_id = staff_number
WHERE (COALESCE(user_type, '') = 'staff' OR COALESCE(role, '') IN ('staff', 'instructor', 'super_admin', 'technician', 'iiw_instructor', 'iiw_admin'))
  AND COALESCE(NULLIF(BTRIM(staff_number), ''), '') <> ''
  AND COALESCE(NULLIF(BTRIM(staff_auto_id), ''), '') IS DISTINCT FROM COALESCE(NULLIF(BTRIM(staff_number), ''), '');

UPDATE public.profiles
SET student_number = staff_number
WHERE (COALESCE(user_type, '') = 'staff' OR COALESCE(role, '') IN ('staff', 'instructor', 'super_admin', 'technician', 'iiw_instructor', 'iiw_admin'))
  AND COALESCE(NULLIF(BTRIM(staff_number), ''), '') <> ''
  AND COALESCE(NULLIF(BTRIM(student_number), ''), '') IS DISTINCT FROM COALESCE(NULLIF(BTRIM(staff_number), ''), '');

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_staff_number_unique
  ON public.profiles (staff_number)
  WHERE staff_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_staff_auto_id_unique
  ON public.profiles (staff_auto_id)
  WHERE staff_auto_id IS NOT NULL;
