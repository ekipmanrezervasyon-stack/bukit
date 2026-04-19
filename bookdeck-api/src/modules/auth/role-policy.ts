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

const parseEmailAllowlist = (): Set<string> => {
  const raw = String(env.SUPER_ADMIN_EMAIL_ALLOWLIST || "").trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((v) => normalize(v))
      .filter(Boolean)
  );
};

const superAdminEmailAllowlist = parseEmailAllowlist();

export const isTrustedSuperAdminEmail = (email: unknown): boolean => {
  const e = normalize(email);
  if (!e) return false;
  return superAdminEmailAllowlist.has(e);
};

export const normalizeRoleForProfile = (role: unknown, userType: unknown): string => {
  const normalizedRole = normalize(role);
  if (ROLE_SET.has(normalizedRole)) return normalizedRole;
  return normalize(userType) === "staff" ? "staff" : "student";
};

export const sanitizeRoleByPolicy = (role: unknown, email: unknown, userType: unknown): string => {
  const normalizedRole = normalizeRoleForProfile(role, userType);
  if (normalizedRole !== "super_admin") return normalizedRole;
  return isTrustedSuperAdminEmail(email) ? "super_admin" : "staff";
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
  if (safeRole === normalize(profile.role)) return profile;

  const q = await supabaseAdmin
    .from("profiles")
    .update({
      role: safeRole,
      updated_at: new Date().toISOString()
    })
    .eq("id", id)
    .select("*")
    .single();

  if (q.error || !q.data) return { ...profile, role: safeRole } as T;
  return q.data as T;
};
