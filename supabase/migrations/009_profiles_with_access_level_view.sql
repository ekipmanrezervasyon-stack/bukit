-- Computed access level view for quick inspection in Supabase Table Editor.
-- Mirrors backend resolveAccessMatrix logic used in API routes.

create or replace view public.profiles_with_access_level as
with normalized as (
  select
    p.*,
    lower(trim(coalesce(p.role, ''))) as role_lc,
    lower(trim(coalesce(p.staff_type, ''))) as staff_type_lc,
    lower(coalesce(p.email, '')) as email_lc,
    upper(trim(coalesce(p.department_code, ''))) as department_code_uc,
    upper(trim(coalesce(p.access_override_level, ''))) as override_raw,
    regexp_replace(coalesce(p.student_number, ''), '\D', '', 'g') as student_digits,
    lower(coalesce(p.faculty_name, '')) as faculty_name_lc,
    case
      when upper(trim(coalesce(p.access_override_level, ''))) = 'SENIOR' then 5
      when trim(coalesce(p.access_override_level, '')) ~ '^[1-5]$' then trim(p.access_override_level)::int
      else null
    end as override_level
  from public.profiles p
),
dept_map as (
  select *
  from (
    values
      ('31', 'MED', 3),
      ('32', 'ADV', 2),
      ('33', 'PUB', 2),
      ('34', 'FTV', 3),
      ('35', 'VCD', 3),
      ('36', 'MAP', 2),
      ('37', 'TVRP', 3),
      ('39', 'ART', 2),
      ('60', 'PA', 2),
      ('156', 'GAME', 2),
      ('305', 'CDM', 2)
  ) as t(code, abbr, base_level)
),
resolved as (
  select
    n.*,
    substring(n.student_digits from 4 for 3) as code3,
    substring(n.student_digits from 4 for 2) as code2,
    case
      when n.student_digits ~ '^\d{2,}$' then substring(n.student_digits from 2 for 2)
      else null
    end as cohort2_raw,
    (
      n.email_lc like '%@bilgiedu.net'
      or n.role_lc = 'student'
      or lower(trim(coalesce(n.user_type, ''))) = 'student'
    ) as is_student,
    (
      n.faculty_name_lc like '%faculty of communication%'
      or n.faculty_name_lc like '%iletişim fakültesi%'
      or n.faculty_name_lc like '%iletisim fakultesi%'
    ) as is_comm_faculty_name
  from normalized n
),
joined as (
  select
    r.*,
    coalesce(dm3.abbr, dm2.abbr) as dept_from_student_abbr,
    coalesce(dm3.base_level, dm2.base_level) as dept_from_student_base_level
  from resolved r
  left join dept_map dm3 on dm3.code = r.code3
  left join dept_map dm2 on dm2.code = r.code2
),
calc as (
  select
    j.*,
    case
      when j.cohort2_raw ~ '^\d{2}$' then j.cohort2_raw::int
      else null
    end as cohort2,
    case
      when j.department_code_uc in (select abbr from dept_map) then j.department_code_uc
      else null
    end as comm_dept_abbr
  from joined j
)
select
  c.*,
  case
    when c.role_lc in ('super_admin', 'technician', 'iiw_instructor', 'iiw_admin') then 5
    when coalesce(c.senior_flag, false) = true or c.override_level = 5 then 5
    when c.is_student = true then
      case
        when c.dept_from_student_base_level is null then 1
        else coalesce(
          c.override_level,
          case
            when c.dept_from_student_base_level = 3 and c.cohort2 is not null and c.cohort2 <= 22 then 4
            else c.dept_from_student_base_level
          end
        )
      end
    when c.staff_type_lc <> 'academic' or c.is_comm_faculty_name = false then coalesce(c.override_level, 1)
    else coalesce(
      c.override_level,
      case
        when coalesce(c.comm_dept_abbr, '') in ('TVRP', 'MED', 'FTV', 'VCD') then 4
        else 2
      end
    )
  end as computed_access_level
from calc c;

comment on view public.profiles_with_access_level is
'Computed access level for profiles based on backend policy (role, senior flag, override, student number matrix, and staff/faculty rules).';
