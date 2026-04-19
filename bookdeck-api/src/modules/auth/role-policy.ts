import { env } from "../../config/env.js";
import { supabaseAdmin } from "../../lib/supabase.js";

const ROLE_SET = new Set([
  "super_admin",
  "technician",
  "iiw_instructor",
  "iiw_admin",
  "instructor",
  "student",
  "staff"
]);

const normalize = (raw: unknown): string => String(raw ?? "").trim().toLowerCase();

const parseEmailAllowlist = (raw: unknown): Set<string> => {
  const normalizedRaw = String(raw || "").trim();
  if (!normalizedRaw) return new Set();
  return new Set(
    normalizedRaw
      .split(",")
      .map((v) => normalize(v))
      .filter(Boolean)
  );
};

const superAdminEmailAllowlist = parseEmailAllowlist(env.SUPER_ADMIN_EMAIL_ALLOWLIST);
const technicianEmailAllowlist = parseEmailAllowlist(env.TECHNICIAN_EMAIL_ALLOWLIST);

export const isTrustedSuperAdminEmail = (email: unknown): boolean => {
  const e = normalize(email);
  if (!e) return false;
  return superAdminEmailAllowlist.has(e);
};

export const isTrustedTechnicianEmail = (email: unknown): boolean => {
  const e = normalize(email);
  if (!e) return false;
  return technicianEmailAllowlist.has(e);
};

export const resolveInitialRoleAndUserType = (email: unknown): { role: string; userType: "student" | "staff" } => {
  const normalizedEmail = normalize(email);
  if (isTrustedSuperAdminEmail(normalizedEmail)) return { role: "super_admin", userType: "staff" };
  if (isTrustedTechnicianEmail(normalizedEmail)) return { role: "technician", userType: "staff" };
  if (normalizedEmail.endsWith("@bilgiedu.net")) return { role: "student", userType: "student" };
  return { role: "staff", userType: "staff" };
};

const sanitizePrivilegedRoleByEmail = (normalizedRole: string, email: unknown): string => {
  if (normalizedRole === "super_admin") return isTrustedSuperAdminEmail(email) ? "super_admin" : "staff";
  if (normalizedRole === "technician") return isTrustedTechnicianEmail(email) ? "technician" : "staff";
  return normalizedRole;
};

export const normalizeRoleForProfile = (role: unknown, userType: unknown): string => {
  const normalizedRole = normalize(role);
  if (ROLE_SET.has(normalizedRole)) return normalizedRole;
  return normalize(userType) === "staff" ? "staff" : "student";
};

export const sanitizeRoleByPolicy = (role: unknown, email: unknown, userType: unknown): string => {
  const normalizedRole = normalizeRoleForProfile(role, userType);
  return sanitizePrivilegedRoleByEmail(normalizedRole, email);
};

type RolePolicyProfile = Record<string, unknown> & {
  id?: string;
  email?: string;
  role?: string;
  user_type?: string;
};

export const enforceRolePolicy = async <T extends RolePolicyProfile>(profile: T): Promise<T> => {
  const id = String(profile.id || "").trim();
  if (!id) return profile;
  const safeRole = sanitizeRoleByPolicy(profile.role, profile.email, profile.user_type);
  const normalizedCurrentRole = normalize(profile.role);
  const nextUserType = safeRole === "student" ? "student" : "staff";
  const normalizedCurrentUserType = normalize(profile.user_type);
  if (safeRole === normalizedCurrentRole && nextUserType === normalizedCurrentUserType) return profile;

  const q = await supabaseAdmin
    .from("profiles")
    .update({
      role: safeRole,
      user_type: nextUserType,
      updated_at: new Date().toISOString()
    })
    .eq("id", id)
    .select("*")
    .single();

  if (q.error || !q.data) {
    return {
      ...profile,
      role: safeRole,
      user_type: nextUserType
    } as T;
  }
  return q.data as T;
};
