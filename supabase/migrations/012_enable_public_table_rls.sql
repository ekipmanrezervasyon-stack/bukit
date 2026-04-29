-- Ensure public application tables are not directly exposed through anon/authenticated keys.
-- The API uses the Supabase service role, which bypasses RLS, so enabling RLS here does
-- not block the backend routes. Tables that do not exist in an environment are skipped.

do $$
declare
  table_name text;
  tables text[] := array[
    'profiles',
    'users',
    'students',
    'equipment_items',
    'inventory_items',
    'rooms',
    'studios',
    'equipment_reservations',
    'equipment_reservation_lines',
    'studio_reservations',
    'assignments',
    'notifications',
    'bans',
    'user_bans',
    'restrictions_bans',
    'audit_log',
    'app_config',
    'tickets',
    'bize_contact',
    'contact_messages',
    'contact_requests',
    'support_messages',
    'equipment_notify_subscriptions',
    'equipment_notify',
    'notify_subscriptions',
    'units',
    'dept_codes',
    'iiw_tasks',
    'iiw_jobs',
    'iiw_hours',
    'iiw_task_hours'
  ];
begin
  foreach table_name in array tables loop
    if to_regclass(format('public.%I', table_name)) is not null then
      execute format('alter table public.%I enable row level security', table_name);
    end if;
  end loop;
end $$;
