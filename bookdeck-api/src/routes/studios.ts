import type { FastifyPluginAsync } from "fastify";
import { supabaseAdmin } from "../lib/supabase.js";
import { getAuthProfile, requireAuth } from "../modules/auth/guards.js";

const hasPrivilegedStudioAccess = (role: string): boolean =>
  role === "super_admin" || role === "technician" || role === "iiw_instructor" || role === "iiw_admin";

const DEPT_MATRIX: Record<string, { abbr: string; baseLevel: number; isApplied: boolean }> = {
  "31": { abbr: "MED", baseLevel: 3, isApplied: true },
  "32": { abbr: "ADV", baseLevel: 2, isApplied: false },
  "33": { abbr: "PUB", baseLevel: 2, isApplied: false },
  "34": { abbr: "FTV", baseLevel: 3, isApplied: true },
  "35": { abbr: "VCD", baseLevel: 3, isApplied: true },
  "36": { abbr: "MAP", baseLevel: 2, isApplied: false },
  "37": { abbr: "TVRP", baseLevel: 3, isApplied: true },
  "39": { abbr: "ART", baseLevel: 2, isApplied: false },
  "60": { abbr: "PA", baseLevel: 2, isApplied: false },
  "156": { abbr: "GAME", baseLevel: 2, isApplied: false },
  "305": { abbr: "CDM", baseLevel: 2, isApplied: false }
};

const parseBoolLike = (raw: unknown): boolean => {
  if (typeof raw === "boolean") return raw;
  const s = String(raw || "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
};

const parseOverrideLevel = (raw: unknown): number | null => {
  const v = String(raw ?? "").trim().toUpperCase();
  if (!v) return null;
  if (v === "SENIOR") return 5;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 1 && n <= 5) return n;
  return null;
};

const parseStudentDeptFromNumber = (studentNoRaw: unknown): { code: string; abbr: string; baseLevel: number; isApplied: boolean } | null => {
  const sid = String(studentNoRaw ?? "").replace(/\D/g, "");
  if (!sid) return null;
  const code3 = sid.length >= 6 ? sid.substring(3, 6) : "";
  const code2 = sid.length >= 5 ? sid.substring(3, 5) : "";
  const rec = DEPT_MATRIX[code3] || DEPT_MATRIX[code2];
  if (!rec) return null;
  return { code: code3 && DEPT_MATRIX[code3] ? code3 : code2, abbr: rec.abbr, baseLevel: rec.baseLevel, isApplied: rec.isApplied };
};

const isCommFacultyName = (raw: unknown): boolean => {
  const v = String(raw ?? "").toLowerCase();
  return v.includes("faculty of communication") || v.includes("iletişim fakültesi") || v.includes("iletisim fakultesi");
};

const resolveCommDeptAbbr = (profile: Record<string, unknown>): string => {
  const dc = String(profile.department_code ?? "").trim().toUpperCase();
  if (dc) return dc;
  const faculty = String(profile.faculty_name ?? "").trim().toUpperCase();
  const tail = faculty.includes("-") ? faculty.split("-").pop() || "" : faculty;
  const abbr = String(tail || "").trim().replace(/\s+/g, "");
  if (Object.values(DEPT_MATRIX).some((x) => x.abbr === abbr)) return abbr;
  return "";
};

const resolveAccessMatrix = (profile: Record<string, unknown>): { maxEquipmentLevel: number; studioBands: Array<"A" | "B"> } => {
  const role = String(profile.role ?? "").toLowerCase();
  if (hasPrivilegedStudioAccess(role)) return { maxEquipmentLevel: 5, studioBands: ["A", "B"] };
  const override = parseOverrideLevel(profile.access_override_level);
  const senior = override === 5 || parseBoolLike(profile.senior_flag);
  if (senior) return { maxEquipmentLevel: 5, studioBands: ["A", "B"] };

  const email = String(profile.email ?? "").toLowerCase();
  const isStudent = email.endsWith("@bilgiedu.net") || role === "student";
  if (isStudent) {
    const dept = parseStudentDeptFromNumber(profile.student_number);
    if (!dept) return { maxEquipmentLevel: 1, studioBands: [] };
    const cohortRaw = String(profile.student_number ?? "").replace(/\D/g, "");
    const cohort2 = cohortRaw.length >= 3 ? Number(cohortRaw.substring(1, 3)) : NaN;
    const autoLvl4 = dept.baseLevel === 3 && Number.isFinite(cohort2) && cohort2 <= 22;
    const base = autoLvl4 ? 4 : dept.baseLevel;
    return { maxEquipmentLevel: override ?? base, studioBands: ["A"] };
  }

  const staffType = String(profile.staff_type ?? "").toLowerCase();
  const commDept = resolveCommDeptAbbr(profile);
  const isComm = isCommFacultyName(profile.faculty_name) || Boolean(commDept);
  if (staffType !== "academic" || !isComm) return { maxEquipmentLevel: override ?? 1, studioBands: ["A"] };
  const practical = ["TVRP", "MED", "FTV", "VCD"].includes(commDept);
  return { maxEquipmentLevel: override ?? (practical ? 4 : 2), studioBands: ["A"] };
};

const isSpecialAccessActive = (untilRaw: string): boolean => {
  const until = String(untilRaw || "").trim();
  if (!until) return true;
  const ms = new Date(until).getTime();
  return Number.isFinite(ms) && ms >= Date.now();
};

const normalizeWeekendFlag = (raw: unknown): boolean => {
  if (typeof raw === "boolean") return raw;
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return false;
  if (v === "1" || v === "true" || v === "yes" || v === "y" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "n" || v === "off") return false;
  return Boolean(v);
};

const resolveStudioKey = (row: Record<string, unknown>): string => {
  const candidates = [
    row.id,
    (row as Record<string, unknown>).studio_id,
    (row as Record<string, unknown>).code,
    (row as Record<string, unknown>).studio_code,
    row.name
  ];
  const canonical = ["GREEN", "RED", "BLUE", "PODCAST", "DUBBING"] as const;
  for (const raw of candidates) {
    const v = String(raw ?? "").trim().toUpperCase();
    if (!v) continue;
    for (const key of canonical) {
      if (v === key || v.includes(key)) return key;
    }
  }
  return String(row.id || "").trim().toUpperCase();
};

const canAccessStudioByPolicy = (
  profile: { role?: string; special_access?: string | null; special_access_until?: string | null },
  studioRow: Record<string, unknown>
): boolean => {
  const key = resolveStudioKey(studioRow);
  if (!key) return false;
  const mx = resolveAccessMatrix(profile as Record<string, unknown>);
  const accessRaw = String(studioRow.access_level || "").trim().toUpperCase();
  const requiredBand: "A" | "B" = accessRaw === "B" || key === "RED" || key === "BLUE" ? "B" : "A";
  if (mx.studioBands.includes(requiredBand)) return true;
  const specialStudio = String(profile.special_access || "").trim().toUpperCase();
  return requiredBand === "B" && key === specialStudio && isSpecialAccessActive(String(profile.special_access_until || ""));
};

const STUDIO_PROJECT_LINK_MARKER_REGEX = /\[PROJECT_LINK:([^\]]+)\]\s*$/i;
const decodeStudioPurpose = (raw: unknown): { purpose: string; projectLink: string } => {
  const full = String(raw || "").trim();
  if (!full) return { purpose: "", projectLink: "" };
  const m = full.match(STUDIO_PROJECT_LINK_MARKER_REGEX);
  if (!m) return { purpose: full, projectLink: "" };
  const projectLink = String(m[1] || "").trim();
  const markerStart = typeof m.index === "number" ? m.index : full.length;
  const purpose = full.slice(0, markerStart).replace(/\s+$/g, "");
  return { purpose, projectLink };
};

export const studioRoutes: FastifyPluginAsync = async (app) => {
  app.get("/studios", { preHandler: requireAuth }, async (req, reply) => {
    const profile = getAuthProfile(req);
    const { data, error } = await supabaseAdmin
      .from("studios")
      .select("*")
      .order("name", { ascending: true });
    if (error) return reply.code(500).send({ ok: false, error: error.message });

    const rows = (data ?? []) as Record<string, unknown>[];
    const visible = rows.filter((row) => canAccessStudioByPolicy(profile, row));

    const normalized = visible.map((row) => {
      const sid = resolveStudioKey(row);
      const rawWeekend =
        (row as Record<string, unknown>).weekendOk ??
        (row as Record<string, unknown>).weekend_ok ??
        (row as Record<string, unknown>).weekend_allowed;
      const weekendOk = sid === "GREEN" ? true : normalizeWeekendFlag(rawWeekend);
      return { ...row, weekendOk };
    });
    return { ok: true, data: normalized };
  });

  app.get("/studio-reservations", { preHandler: requireAuth }, async (req, reply) => {
    const q = req.query as { status?: string; requester_email?: string; from?: string; to?: string };
    let query = supabaseAdmin.from("studio_reservations").select("*").order("start_at", { ascending: true });
    if (q.status) query = query.eq("status", q.status);
    if (q.requester_email) query = query.eq("requester_email", q.requester_email);
    const from = String(q.from || "").trim();
    const to = String(q.to || "").trim();
    // Range queries must include reservations that overlap the window,
    // not only rows fully contained in it.
    if (from && to) {
      query = query.lt("start_at", to).gt("end_at", from);
    } else if (from) {
      query = query.gt("end_at", from);
    } else if (to) {
      query = query.lt("start_at", to);
    }
    const { data, error } = await query;
    if (error) return reply.code(500).send({ ok: false, error: error.message });
    const out = ((data ?? []) as Record<string, unknown>[]).map((row) => {
      const decoded = decodeStudioPurpose(row.purpose);
      return {
        ...row,
        purpose: decoded.purpose,
        project_link: decoded.projectLink
      };
    });
    return { ok: true, data: out };
  });
};
