import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { supabaseAdmin } from "../../lib/supabase.js";
import { verifySessionToken } from "./session.js";

export type AppRole =
  | "super_admin"
  | "technician"
  | "iiw_instructor"
  | "iiw_admin"
  | "instructor"
  | "student"
  | "staff";

export type ProfileRow = {
  id: string;
  email: string;
  role: AppRole;
  user_type: "student" | "staff";
  full_name: string | null;
  student_number: string | null;
  staff_number: string | null;
  department_code: string | null;
  department_name: string | null;
  access_override_level: string | null;
  senior_flag: boolean;
  is_active: boolean;
  onboarding_completed: boolean;
  staff_type: "academic" | "administrative" | null;
  faculty_name: string | null;
  special_access: string | null;
  special_access_until: string | null;
};

type AuthedReq = FastifyRequest & { authProfile?: ProfileRow };

const getBearerToken = (req: FastifyRequest): string => {
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) return "";
  return auth.substring(7).trim();
};

const loadProfileForRequest = async (req: FastifyRequest): Promise<ProfileRow | null> => {
  const casted = req as AuthedReq;
  if (casted.authProfile) return casted.authProfile;
  const token = getBearerToken(req);
  if (!token) return null;
  const payload = verifySessionToken(token);
  if (!payload) return null;

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("*")
    .eq("id", payload.sub)
    .limit(1)
    .maybeSingle();
  if (error || !data || !data.is_active) return null;
  casted.authProfile = data as ProfileRow;
  return casted.authProfile;
};

export const requireAuth: preHandlerHookHandler = async (req, reply) => {
  const p = await loadProfileForRequest(req);
  if (!p) return reply.code(401).send({ ok: false, error: "Unauthorized." });
};

export const requireRoles = (roles: AppRole[]): preHandlerHookHandler => {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const p = await loadProfileForRequest(req);
    if (!p) return reply.code(401).send({ ok: false, error: "Unauthorized." });
    if (!roles.includes(p.role)) {
      return reply.code(403).send({ ok: false, error: "Forbidden." });
    }
  };
};

export const getAuthProfile = (req: FastifyRequest): ProfileRow => {
  const p = (req as AuthedReq).authProfile;
  if (!p) throw new Error("Missing auth profile on request.");
  return p;
};

export const isAdminRole = (role: AppRole): boolean =>
  role === "super_admin" || role === "technician" || role === "iiw_instructor";
