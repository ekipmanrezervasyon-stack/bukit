import { supabaseAdmin } from "../../lib/supabase.js";

type SyncableProfile = Record<string, unknown> & {
  id?: string;
  role?: string;
  user_type?: string;
  student_number?: string | null;
  staff_number?: string | null;
  staff_auto_id?: string | null;
};

const STAFF_ROLES = new Set(["staff", "instructor", "super_admin", "technician", "iiw_instructor", "iiw_admin"]);

const isStaffLikeProfile = (profile: SyncableProfile): boolean => {
  const role = String(profile.role ?? "").trim().toLowerCase();
  const userType = String(profile.user_type ?? "").trim().toLowerCase();
  return userType === "staff" || STAFF_ROLES.has(role);
};

const normalize = (raw: unknown): string => String(raw ?? "").trim();
const STF_RE = /^STF(\d+)$/i;
const STAFF_PAD = 7;

const pickExistingStaffCode = (profile: SyncableProfile): string => {
  const candidates = [
    normalize(profile.staff_number),
    normalize(profile.staff_auto_id),
    normalize(profile.student_number)
  ].filter(Boolean);
  for (const c of candidates) {
    if (STF_RE.test(c)) return c.toUpperCase();
  }
  return "";
};

const nextStaffCode = async (profile: SyncableProfile): Promise<string> => {
  const selectCols = ["student_number"];
  if ("staff_number" in profile) selectCols.push("staff_number");
  if ("staff_auto_id" in profile) selectCols.push("staff_auto_id");

  const q = await supabaseAdmin
    .from("profiles")
    .select(selectCols.join(","))
    .or("user_type.eq.staff,role.in.(staff,instructor,super_admin,technician,iiw_instructor,iiw_admin)")
    .limit(20000);

  let maxVal = 0;
  if (!q.error) {
    for (const row of ((q.data ?? []) as unknown as Array<Record<string, unknown>>)) {
      const vals = [
        normalize(row.student_number),
        normalize((row as { staff_number?: unknown }).staff_number),
        normalize((row as { staff_auto_id?: unknown }).staff_auto_id)
      ];
      for (const v of vals) {
        const m = v.match(STF_RE);
        if (!m) continue;
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > maxVal) maxVal = n;
      }
    }
  }
  return `STF${String(maxVal + 1).padStart(STAFF_PAD, "0")}`;
};

export const needsStaffStudentNumberSync = (profile: SyncableProfile): boolean => {
  if (!isStaffLikeProfile(profile)) return false;
  const staff = pickExistingStaffCode(profile);
  if (!staff) return true;
  const student = normalize(profile.student_number);
  return student !== staff;
};

export const ensureStaffStudentNumberSync = async <T extends SyncableProfile>(profile: T): Promise<T> => {
  const id = normalize(profile.id);
  if (!id || !isStaffLikeProfile(profile)) return profile;

  const staff = pickExistingStaffCode(profile) || (await nextStaffCode(profile));
  const patch: Record<string, unknown> = {};
  if (normalize(profile.student_number) !== staff) patch.student_number = staff;
  if ("staff_number" in profile && normalize(profile.staff_number) !== staff) patch.staff_number = staff;
  if ("staff_auto_id" in profile && normalize(profile.staff_auto_id) !== staff) patch.staff_auto_id = staff;
  if (!Object.keys(patch).length) return profile;
  patch.updated_at = new Date().toISOString();

  const q = await supabaseAdmin
    .from("profiles")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();

  if (q.error || !q.data) return profile;
  return q.data as T;
};
