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

const parseOverrideLevel = (raw: unknown): number | null => {
  const v = String(raw ?? "").trim().toUpperCase();
  if (!v) return null;
  if (v === "SENIOR") return 5;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 1 && n <= 5) return n;
  return null;
};

const parseEquipmentLevel = (raw: unknown): number => {
  const v = String(raw ?? "").trim().toUpperCase();
  if (!v) return 1;
  const m = v.match(/\b([1-5])\b/);
  if (m) return Number(m[1]);
  if (v.includes("TEMEL")) return 1;
  if (v.includes("ORTA")) return 2;
  if (v.includes("ILERI") || v.includes("İLERİ")) return 3;
  if (v.includes("PRO")) return 4;
  if (v.includes("SENIOR")) return 5;
  return 1;
};

const parseBoolLike = (raw: unknown): boolean => {
  if (typeof raw === "boolean") return raw;
  const s = String(raw || "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
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

const canOperateLevel5Equipment = (profile: Record<string, unknown>): boolean => {
  const role = String(profile.role || "").trim().toLowerCase();
  return role === "super_admin" || role === "technician" || parseBoolLike(profile.senior_flag);
};

const EQUIPMENT_ON_LOAN_RES_STATUSES = ["IN_USE", "in_use", "checked_out", "picked_up", "key_out"];

export const equipmentRoutes: FastifyPluginAsync = async (app) => {
  app.get("/equipment-items", { preHandler: requireAuth }, async (req, reply) => {
    const profile = getAuthProfile(req) as unknown as Record<string, unknown>;
    const q = req.query as { status?: string; category?: string; search?: string };
    let query = supabaseAdmin.from("equipment_items").select("*").order("name", { ascending: true });
    if (q.status) query = query.eq("status", q.status);
    if (q.category) query = query.eq("category", q.category);
    if (q.search) query = query.ilike("name", `%${q.search}%`);
    const { data, error } = await query;
    if (error) return reply.code(500).send({ ok: false, error: error.message });
    const rows = (data ?? []) as Record<string, unknown>[];
    const matrix = resolveAccessMatrix(profile);
    const visibleRows = rows.filter((r) => parseEquipmentLevel(r.required_level) <= matrix.maxEquipmentLevel);

    const itemIds = Array.from(
      new Set(visibleRows.map((r) => String(r.id || "").trim()).filter(Boolean))
    );
    const returnByItemId = new Map<string, string>();
    if (itemIds.length) {
      const qRes = await supabaseAdmin
        .from("equipment_reservations")
        .select("equipment_item_id,end_at,status")
        .in("equipment_item_id", itemIds)
        .in("status", EQUIPMENT_ON_LOAN_RES_STATUSES)
        .not("end_at", "is", null)
        .order("end_at", { ascending: true });
      if (!qRes.error) {
        for (const row of (qRes.data ?? []) as Record<string, unknown>[]) {
          const eqId = String(row.equipment_item_id || "").trim();
          const endAt = String(row.end_at || "").trim();
          if (!eqId || !endAt || returnByItemId.has(eqId)) continue;
          returnByItemId.set(eqId, endAt);
        }
      } else {
        req.log.warn({ err: qRes.error }, "equipment-items: failed to resolve return_date from equipment_reservations");
      }
    }

    const enrichedRows = visibleRows.map((r) => {
      const eqId = String(r.id || "").trim();
      const fallbackReturn =
        String((r.return_date as string) || (r.due_date as string) || (r.end_at as string) || "").trim() ||
        (eqId ? String(returnByItemId.get(eqId) || "").trim() : "");
      return {
        ...r,
        return_date: fallbackReturn
      };
    });

    return { ok: true, data: enrichedRows };
  });

  app.get("/equipment-reservations", { preHandler: requireAuth }, async (req, reply) => {
    const q = req.query as { status?: string; requester_email?: string };
    let query = supabaseAdmin.from("equipment_reservations").select("*").order("start_at", { ascending: false });
    if (q.status) query = query.eq("status", q.status);
    if (q.requester_email) query = query.eq("requester_email", q.requester_email);
    const { data, error } = await query;
    if (error) return reply.code(500).send({ ok: false, error: error.message });
    return { ok: true, data: data ?? [] };
  });
};
