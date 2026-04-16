import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { consumeOtp, getOtp, setOtp } from "../modules/auth/otp-store.js";
import { createSessionToken, verifySessionToken } from "../modules/auth/session.js";
import { sendOtpEmail } from "../modules/auth/otp-mail.js";

const EmailSchema = z.string().email().max(190).transform((v) => v.trim().toLowerCase());
const OtpCodeSchema = z.string().regex(/^\d{6}$/);

const RoleSchema = z.enum([
  "super_admin",
  "technician",
  "iiw_instructor",
  "iiw_admin",
  "instructor",
  "student",
  "staff"
]);

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get("/auth/onboarding/units", async () => {
    const empty = { academic: [], communicationDepartments: [], admin: [] };
    const { data, error } = await supabaseAdmin.from("units").select("*").limit(2000);
    if (error) return empty;
    const rows = Array.isArray(data) ? data : [];
    const acc = { academic: [] as string[], communicationDepartments: [] as string[], admin: [] as string[] };
    for (const r of rows) {
      const row = (r ?? {}) as Record<string, unknown>;
      const raw = (row.raw && typeof row.raw === "object") ? (row.raw as Record<string, unknown>) : null;
      const ac = String(row.academic ?? row.academic_unit ?? row.name ?? row.code ?? "").trim();
      const comm = String(row.communication_department ?? row.communication ?? row.comm_dept ?? "").trim();
      const ad = String(row.admin ?? row.administrative_unit ?? "").trim();
      if (ac) acc.academic.push(ac);
      if (ad) acc.admin.push(ad);
      if (comm) acc.communicationDepartments.push(comm);
      if (raw) {
        const rawAc = String(raw.academic ?? "").trim();
        const rawAd = String(raw.admin ?? "").trim();
        const rawComm = String(raw.communication ?? raw.communication_department ?? "").trim();
        if (rawAc) acc.academic.push(rawAc);
        if (rawAd) acc.admin.push(rawAd);
        if (rawComm) acc.communicationDepartments.push(rawComm);
      }
    }
    return {
      academic: Array.from(new Set(acc.academic)),
      communicationDepartments: Array.from(new Set(acc.communicationDepartments)),
      admin: Array.from(new Set(acc.admin))
    };
  });

  app.post("/auth/otp/request", async (req, reply) => {
    const parsed = z.object({ email: EmailSchema }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "Invalid email." });

    const email = parsed.data.email;
    const code = String(Math.floor(100000 + Math.random() * 900000));
    if (env.OTP_DEV_BYPASS !== "true") {
      try {
        await sendOtpEmail(email, code, env.OTP_CODE_TTL_MINUTES);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        req.log.error({ err: e, email }, "otp email send failed");
        return reply.code(500).send({ ok: false, error: message });
      }
    }
    const ttlMs = env.OTP_CODE_TTL_MINUTES * 60_000;
    setOtp(email, code, ttlMs);

    return {
      ok: true,
      email,
      ttlMinutes: env.OTP_CODE_TTL_MINUTES,
      devOtpCode: env.OTP_DEV_BYPASS === "true" ? code : undefined
    };
  });

  app.post("/auth/otp/verify", async (req, reply) => {
    const parsed = z.object({ email: EmailSchema, code: OtpCodeSchema }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "Invalid payload." });
    const { email, code } = parsed.data;
    const rec = getOtp(email);
    if (!rec) return reply.code(400).send({ ok: false, error: "OTP expired or not found." });
    if (rec.code !== code) return reply.code(400).send({ ok: false, error: "Incorrect OTP." });
    consumeOtp(email);

    const { data: existing, error: findErr } = await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq("email", email)
      .limit(1)
      .maybeSingle();
    if (findErr) return reply.code(500).send({ ok: false, error: findErr.message });

    let profile = existing;
    if (!profile) {
      const insertPayload = {
        email,
        user_type: email.endsWith("@bilgiedu.net") ? "student" : "staff",
        role: email.endsWith("@bilgiedu.net") ? "student" : "staff",
        full_name: "",
        is_active: true,
        onboarding_completed: false
      };
      const { data: created, error: createErr } = await supabaseAdmin
        .from("profiles")
        .insert(insertPayload)
        .select("*")
        .single();
      if (createErr) return reply.code(500).send({ ok: false, error: createErr.message });
      profile = created;
    }

    if (!profile.is_active) return reply.code(403).send({ ok: false, error: "Account inactive." });

    const token = createSessionToken(
      {
        sub: String(profile.id),
        email: String(profile.email),
        role: String(profile.role || "student")
      },
      env.SESSION_TTL_DAYS * 24 * 3600
    );

    return {
      ok: true,
      token,
      profile: {
        id: profile.id,
        email: profile.email,
        role: profile.role,
        user_type: profile.user_type,
        full_name: profile.full_name,
        onboarding_completed: profile.onboarding_completed
      }
    };
  });

  app.get("/auth/session", async (req, reply) => {
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.substring(7).trim() : "";
    if (!token) return reply.code(401).send({ ok: false, error: "Missing bearer token." });
    const payload = verifySessionToken(token);
    if (!payload) return reply.code(401).send({ ok: false, error: "Invalid session token." });

    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq("id", payload.sub)
      .limit(1)
      .maybeSingle();
    if (error) return reply.code(500).send({ ok: false, error: error.message });
    if (!data) return reply.code(404).send({ ok: false, error: "Profile not found." });

    return { ok: true, profile: data };
  });

  app.post("/auth/onboarding/student", async (req, reply) => {
    const parsed = z
      .object({
        token: z.string().min(20),
        full_name: z.string().min(2).max(120),
        student_number: z.string().min(4).max(32),
        department_code: z.string().min(1).max(20),
        department_name: z.string().min(1).max(120)
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "Invalid payload." });
    const p = verifySessionToken(parsed.data.token);
    if (!p) return reply.code(401).send({ ok: false, error: "Invalid session token." });

    const { data, error } = await supabaseAdmin
      .from("profiles")
      .update({
        role: "student",
        user_type: "student",
        full_name: parsed.data.full_name,
        student_number: parsed.data.student_number,
        department_code: parsed.data.department_code,
        department_name: parsed.data.department_name,
        onboarding_completed: true,
        updated_at: new Date().toISOString()
      })
      .eq("id", p.sub)
      .select("*")
      .single();
    if (error) return reply.code(500).send({ ok: false, error: error.message });
    return { ok: true, profile: data };
  });

  app.post("/auth/onboarding/staff", async (req, reply) => {
    const parsed = z
      .object({
        token: z.string().min(20),
        full_name: z.string().min(2).max(120),
        staff_type: z.enum(["academic", "administrative"]),
        faculty_name: z.string().min(1).max(120),
        role: RoleSchema.optional()
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "Invalid payload." });
    const p = verifySessionToken(parsed.data.token);
    if (!p) return reply.code(401).send({ ok: false, error: "Invalid session token." });

    const safeRole = parsed.data.role && parsed.data.role !== "student" ? parsed.data.role : "staff";
    const facultyName = String(parsed.data.faculty_name || "").trim();
    const lowFaculty = facultyName.toLowerCase();
    const isCommFaculty =
      lowFaculty.includes("faculty of communication") ||
      lowFaculty.includes("iletişim fakültesi") ||
      lowFaculty.includes("iletisim fakultesi");
    const departmentCode = isCommFaculty ? "COMM" : "NON_FACULTY";
    const departmentName = isCommFaculty ? facultyName : `Non-Faculty - ${facultyName}`;
    const { data, error } = await supabaseAdmin
      .from("profiles")
      .update({
        role: safeRole,
        user_type: "staff",
        full_name: parsed.data.full_name,
        staff_type: parsed.data.staff_type,
        faculty_name: facultyName,
        department_code: departmentCode,
        department_name: departmentName,
        onboarding_completed: true,
        updated_at: new Date().toISOString()
      })
      .eq("id", p.sub)
      .select("*")
      .single();
    if (error) return reply.code(500).send({ ok: false, error: error.message });
    return { ok: true, profile: data };
  });
};
