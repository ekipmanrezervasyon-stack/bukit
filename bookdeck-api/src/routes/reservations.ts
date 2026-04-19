import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { generateCheckoutPdf } from "../lib/google-pdf.js";
import { getAuthProfile, isAdminRole, requireAuth, requireRoles, type AppRole } from "../modules/auth/guards.js";

const isoDateSchema = z
  .string()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), "Invalid datetime");

const studioCreateSchema = z.object({
  studio_id: z.string().min(1),
  start_at: isoDateSchema,
  end_at: isoDateSchema,
  purpose: z.string().max(120).optional().default("")
});

const equipmentCreateSchema = z.object({
  equipment_item_id: z.string().min(1),
  start_at: isoDateSchema,
  end_at: isoDateSchema,
  note: z.string().max(500).optional().default("")
});

const decisionSchema = z.object({
  id: z.string().min(1),
  note: z.string().max(500).optional()
});
const myBookingCancelSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1)
});

const ADMIN_ROLES: AppRole[] = ["super_admin", "technician", "iiw_instructor", "iiw_admin"];
const EQUIPMENT_CHECKED_OUT_STATUS = "IN_USE";
const EQUIPMENT_CHECKED_OUT_STATUS_CANDIDATES = Array.from(
  new Set([EQUIPMENT_CHECKED_OUT_STATUS, "in_use", "checked_out", "picked_up", "key_out"])
);
const EQUIPMENT_ACTIVE_RES_STATUSES = ["pending", "approved", "IN_USE", "in_use", "checked_out", "picked_up", "key_out"];
const EQUIPMENT_CLOSED_RES_STATUSES = ["cancelled", "rejected", "returned", "completed"];
const ACTIVE_TICKET_STATUSES = ["pending", "beklemede", "beklemede / pending"];
const EQUIPMENT_ON_LOAN_RES_STATUSES = ["IN_USE", "in_use", "checked_out", "picked_up", "key_out"];
const EQUIPMENT_CATEGORY_LIMITS: Record<string, number> = { Cam: 1, Ops: 2, Sound: 3, Light: 5, Grip: 5 };
const EQUIPMENT_CATEGORY_DEFAULT_LIMIT = 5;
const STUDIO_PENDING_STATUS = "pending";
const STUDIO_APPROVED_STATUS = "approved_by_admin";
const STUDIO_REJECTED_STATUS = "rejected_by_admin";
const STUDIO_CANCELLED_STATUS = "cancelled_by_user";
const STUDIO_PICKED_STATUS = "key_picked";
const STUDIO_RETURNED_STATUS = "key_returned";
const STUDIO_ACTIVE_RES_STATUSES = [STUDIO_PENDING_STATUS, STUDIO_APPROVED_STATUS, STUDIO_PICKED_STATUS, "approved"];
const STUDIO_CLOSED_RES_STATUSES = [STUDIO_CANCELLED_STATUS, STUDIO_REJECTED_STATUS, STUDIO_RETURNED_STATUS, "cancelled", "rejected", "completed"];
const ALL_ACTIVE_RES_STATUSES = Array.from(new Set([...EQUIPMENT_ACTIVE_RES_STATUSES, ...STUDIO_ACTIVE_RES_STATUSES]));
const ALL_CLOSED_RES_STATUSES = Array.from(new Set([...EQUIPMENT_CLOSED_RES_STATUSES, ...STUDIO_CLOSED_RES_STATUSES]));
const NOTIFY_TABLE_CANDIDATES = ["equipment_notify_subscriptions", "equipment_notify", "notify_subscriptions"];

const notifySubscribeSchema = z.object({
  group_key: z.string().min(1).max(190),
  label: z.string().max(190).optional().default("")
});

const contactMessageSchema = z.object({
  reservation_ref: z.string().min(1).max(120),
  message: z.string().min(1).max(300)
});

const ticketCreateSchema = z.object({
  ticket_type: z.string().min(1).max(120),
  start_at: isoDateSchema,
  end_at: isoDateSchema,
  location: z.string().max(190).optional().default(""),
  description: z.string().min(1).max(1000),
  phone: z.string().max(40).optional().default("")
});

const quickLookupSchema = z.object({
  query: z.string().min(1).max(190)
});

const forwardAvailabilitySchema = z.object({
  start_at: isoDateSchema,
  end_at: isoDateSchema
});

const inventoryMetaSchema = z.object({
  location: z.string().max(190).optional(),
  responsible: z.string().max(190).optional(),
  condition_in: z.string().max(120).optional(),
  status: z.enum(["AVAILABLE", "IN_USE", "BROKEN", "MAINTENANCE", "MAINTANENCE"]).optional()
});

const ticketDecisionSchema = z.object({
  ticket_no: z.string().min(1),
  note: z.string().max(1000).optional(),
  reason: z.string().max(1000).optional()
});

const bizeReplySchema = z.object({
  row_id: z.string().min(1),
  reply_text: z.string().min(1).max(1000)
});

const quickCheckoutSchema = z.object({
  cart_ids: z.array(z.string().min(1)).min(1),
  email: z.string().email(),
  return_dt: isoDateSchema.optional(),
  display_name: z.string().max(190).optional().default(""),
  project_purpose: z.string().max(300).optional().default("")
});

const adminTrafficActionSchema = z.object({
  id: z.string().min(1),
  item_ids: z.array(z.string().min(1)).max(50).optional().default([]),
  studio_handover_note: z.string().max(500).optional().default(""),
  checkout_condition_map: z.record(z.string(), z.string().max(120)).optional().default({})
});
const adminTrafficExtendSchema = z.object({
  id: z.string().min(1),
  new_end_at: isoDateSchema
});
const adminTrafficTransferSchema = z.object({
  id: z.string().min(1),
  query: z.string().min(1).max(190)
});
const adminEquipmentLookupSchema = z.object({
  query: z.string().min(1).max(190)
});
const adminOverdueReminderSchema = z.object({
  equipment_ids: z.array(z.string().min(1)).min(1)
});

const specialAccessUpsertSchema = z.object({
  email: z.string().email(),
  studio: z.enum(["GREEN", "RED", "PODCAST", "DUBBING"]),
  until: z.string().optional().default("")
});

const specialEquipmentUpsertSchema = z.object({
  email: z.string().email(),
  equipment_id: z.string().min(1),
  until: z.string().optional().default("")
});

const specialAccessDeleteSchema = z.object({
  email: z.string().email()
});

const iiwSaveHoursSchema = z.object({
  task_id: z.string().min(1),
  student_email: z.string().email(),
  hours: z.union([z.number(), z.string()])
});

const reservationIsActive = (status: string): boolean => {
  const s = String(status || "").trim().toLowerCase();
  return ALL_ACTIVE_RES_STATUSES.includes(s) && !ALL_CLOSED_RES_STATUSES.includes(s);
};

const normalizeCheckoutConditionOut = (raw: unknown): "Excellent" | "Minor Scratch" | "Missing Part" | "DAMAGED" => {
  const s = String(raw || "").trim();
  if (s === "Excellent" || s === "Minor Scratch" || s === "Missing Part" || s === "DAMAGED" || s === "Damaged") {
    return s.toUpperCase() === "DAMAGED" || s === "Damaged" ? "DAMAGED" : (s as "Excellent" | "Minor Scratch" | "Missing Part");
  }
  const low = s.toLowerCase();
  if (low.includes("minor") && low.includes("scratch")) return "Minor Scratch";
  if (low.includes("missing")) return "Missing Part";
  if (low.includes("damage") || low.includes("hasar")) return "DAMAGED";
  return "Excellent";
};

const dedupeTrimmedIds = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const id = String(v || "").trim();
    if (!id) continue;
    const k = id.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(id);
  }
  return out;
};

const findMappedConditionOut = (conditionMap: Record<string, string>, eqId: string): string | null => {
  const id = String(eqId || "").trim();
  if (!id) return null;
  const direct = conditionMap[id];
  if (typeof direct === "string" && direct.trim()) return normalizeCheckoutConditionOut(direct);
  const low = conditionMap[id.toLowerCase()];
  if (typeof low === "string" && low.trim()) return normalizeCheckoutConditionOut(low);
  const up = conditionMap[id.toUpperCase()];
  if (typeof up === "string" && up.trim()) return normalizeCheckoutConditionOut(up);
  return null;
};

const isMissingProfilesColumnError = (err: unknown, column: string): boolean => {
  if (!err || typeof err !== "object") return false;
  const obj = err as { message?: string; details?: string; hint?: string };
  const msg = `${String(obj.message || "")} ${String(obj.details || "")} ${String(obj.hint || "")}`.toLowerCase();
  return msg.includes(`profiles.${String(column || "").toLowerCase()}`) && msg.includes("does not exist");
};

const lookupProfileByAdminQuery = async (
  rawQuery: string
): Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }> => {
  const raw = String(rawQuery || "").trim();
  if (!raw) return { data: null, error: null };
  const isEmail = raw.includes("@");

  if (isEmail) {
    const byEmail = await supabaseAdmin.from("profiles").select("*").eq("email", raw.toLowerCase()).limit(1).maybeSingle();
    if (byEmail.error) return { data: null, error: { message: byEmail.error.message } };
    if (byEmail.data) return { data: byEmail.data as Record<string, unknown>, error: null };
  } else {
    let lastErr: { message: string } | null = null;
    for (const col of ["student_number", "staff_auto_id", "staff_number"]) {
      const byCol = await supabaseAdmin.from("profiles").select("*").eq(col, raw).limit(1).maybeSingle();
      if (!byCol.error && byCol.data) return { data: byCol.data as Record<string, unknown>, error: null };
      if (byCol.error) {
        if (isMissingProfilesColumnError(byCol.error, col)) continue;
        lastErr = { message: byCol.error.message };
        break;
      }
    }
    if (lastErr) return { data: null, error: lastErr };
  }

  const likeNeedle = `%${raw.replace(/[%_]/g, "\\$&")}%`;
  const byName = await supabaseAdmin.from("profiles").select("*").ilike("full_name", likeNeedle).limit(1);
  if (byName.error) return { data: null, error: { message: byName.error.message } };
  if ((byName.data ?? []).length > 0) return { data: byName.data?.[0] as Record<string, unknown>, error: null };

  const byEmailLike = await supabaseAdmin.from("profiles").select("*").ilike("email", likeNeedle).limit(1);
  if (byEmailLike.error) return { data: null, error: { message: byEmailLike.error.message } };
  if ((byEmailLike.data ?? []).length > 0) return { data: byEmailLike.data?.[0] as Record<string, unknown>, error: null };

  return { data: null, error: null };
};

const isEquipmentReservationStatusConstraintError = (err: unknown): boolean => {
  if (!err || typeof err !== "object") return false;
  const obj = err as { code?: string; message?: string; details?: string; hint?: string };
  const msg = `${String(obj.message || "")} ${String(obj.details || "")} ${String(obj.hint || "")}`.toLowerCase();
  if (String(obj.code || "") === "23514") return true;
  if (msg.includes("equipment_reservations_status_check")) return true;
  return msg.includes("violates check constraint") && msg.includes("status");
};

const updateEquipmentReservationToCheckedOut = async (
  reservationId: string,
  patch: Record<string, unknown>
): Promise<{ data: Record<string, unknown> | null; status: string; error: { message: string } | null }> => {
  let lastErr: { message: string } | null = null;
  for (const candidate of EQUIPMENT_CHECKED_OUT_STATUS_CANDIDATES) {
    const upd = await supabaseAdmin
      .from("equipment_reservations")
      .update({ ...patch, status: candidate })
      .eq("id", reservationId)
      .select("id,status")
      .single();
    if (!upd.error) {
      return {
        data: (upd.data as Record<string, unknown> | null) || null,
        status: String((upd.data as Record<string, unknown> | null)?.status || candidate),
        error: null
      };
    }
    if (isEquipmentReservationStatusConstraintError(upd.error)) {
      lastErr = { message: upd.error.message };
      continue;
    }
    return { data: null, status: candidate, error: { message: upd.error.message } };
  }
  return {
    data: null,
    status: EQUIPMENT_CHECKED_OUT_STATUS,
    error: lastErr || { message: "No supported checked-out status value matched equipment_reservations_status_check." }
  };
};

const insertEquipmentReservationAsCheckedOut = async (
  payload: Record<string, unknown>
): Promise<{ data: Record<string, unknown> | null; status: string; error: { message: string } | null }> => {
  let lastErr: { message: string } | null = null;
  for (const candidate of EQUIPMENT_CHECKED_OUT_STATUS_CANDIDATES) {
    const ins = await supabaseAdmin
      .from("equipment_reservations")
      .insert({ ...payload, status: candidate })
      .select("id,status")
      .single();
    if (!ins.error) {
      return {
        data: (ins.data as Record<string, unknown> | null) || null,
        status: String((ins.data as Record<string, unknown> | null)?.status || candidate),
        error: null
      };
    }
    if (isEquipmentReservationStatusConstraintError(ins.error)) {
      lastErr = { message: ins.error.message };
      continue;
    }
    return { data: null, status: candidate, error: { message: ins.error.message } };
  }
  return {
    data: null,
    status: EQUIPMENT_CHECKED_OUT_STATUS,
    error: lastErr || { message: "No supported checked-out status value matched equipment_reservations_status_check." }
  };
};

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

const normalizeCategoryBlob = (raw: unknown): string =>
  String(raw ?? "")
    .toLowerCase()
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ı/g, "i")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c");

const normalizeModelNameKey = (raw: unknown): string =>
  String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  Cam: ["cam", "kamera", "camera", "dslr", "video"],
  Ops: ["opt", "lens", "optik", "optics", "filtre", "filter"],
  Sound: ["snd", "sound", "ses", "audio", "recorder", "mikser", "mic", "mikrofon", "yaka", "boom"],
  Light: ["lgh", "light", "isik", "lighting", "led"],
  Grip: ["grp", "grip", "tripod", "ayak", "stand", "gimbal"]
};

const isLightStandGripBlob = (blob: string): boolean => {
  const s = normalizeCategoryBlob(blob);
  return s.includes("light stand") || s.includes("lighting stand");
};

const resolveEquipmentCategoryBucket = (item: Record<string, unknown>): "Cam" | "Ops" | "Sound" | "Light" | "Grip" | "Other" => {
  const blob = normalizeCategoryBlob(
    `${String(item.category || "")} ${String(item.type || "")} ${String(item.type_desc || "")} ${String(item.name || "")} ${String(item.equipment_id || "")} ${String(item.id || "")}`
  );
  if (isLightStandGripBlob(blob)) return "Grip";
  for (const key of Object.keys(CATEGORY_KEYWORDS) as Array<"Cam" | "Ops" | "Sound" | "Light" | "Grip">) {
    if (CATEGORY_KEYWORDS[key].some((kw) => blob.includes(kw))) return key;
  }
  return "Other";
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
  const senior = override === 5 || Boolean(profile.senior_flag);
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

const canAccessStudioByPolicy = (
  profile: { role?: string; special_access?: string | null; special_access_until?: string | null },
  studioRow: Record<string, unknown>
): boolean => {
  const sidCandidates = [
    studioRow.id,
    studioRow.studio_id,
    studioRow.code,
    studioRow.studio_code,
    studioRow.name
  ];
  const canonical = ["GREEN", "RED", "BLUE", "PODCAST", "DUBBING"] as const;
  let sid = "";
  for (const raw of sidCandidates) {
    const v = String(raw ?? "").trim().toUpperCase();
    if (!v) continue;
    sid = v;
    for (const key of canonical) {
      if (v === key || v.includes(key)) {
        sid = key;
        break;
      }
    }
    if (sid === "GREEN" || sid === "RED" || sid === "BLUE" || sid === "PODCAST" || sid === "DUBBING") break;
  }
  if (!sid) return false;
  const mx = resolveAccessMatrix(profile as Record<string, unknown>);
  const requiredBand: "A" | "B" = sid === "RED" || sid === "BLUE" ? "B" : "A";
  if (mx.studioBands.includes(requiredBand)) return true;
  const specialStudio = String(profile.special_access || "").trim().toUpperCase();
  return requiredBand === "B" && sid === specialStudio && isSpecialAccessActive(String(profile.special_access_until || ""));
};

const normalizeInvStatusEnglish = (status: string): string => {
  const s = String(status || "").trim().toUpperCase();
  if (s === "AVAILABLE" || s === "MUSAIT" || s === "MÜSAİT" || s === "UYGUN") return "Available";
  if (s === "IN_USE" || s === "IN USE" || s === "KULLANIMDA" || s === "DISARIDA" || s === "DIŞARIDA") return "In Use";
  if (s === "MAINTENANCE" || s === "MAINTANENCE") return "Maintenance";
  if (s.includes("DAMAGE") || s === "BOZUK" || s === "HASARLI" || s === "BROKEN") return "Damaged";
  return status || "Unknown";
};

const normalizeEquipmentNameKeyForNotify = (raw: unknown): string =>
  String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ı/g, "i")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/\s+/g, " ");

const equipmentNotifyGroupKeyByName = (rawName: unknown): string => {
  const slug = normalizeEquipmentNameKeyForNotify(rawName)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `name:${slug || "unknown"}`;
};

const buildNotifyGroupKeyCandidates = (item: { id?: unknown; equipment_id?: unknown; name?: unknown }): string[] => {
  const set = new Set<string>();
  const id = String(item.id || "").trim();
  const code = String(item.equipment_id || "").trim();
  const name = String(item.name || "").trim();
  if (id) set.add(id);
  if (code) {
    set.add(code);
    set.add(code.toLowerCase());
    set.add(code.toUpperCase());
  }
  if (name) set.add(equipmentNotifyGroupKeyByName(name));
  return Array.from(set.values()).filter(Boolean);
};

let notifyTableCache: string | null | undefined;
const resolveNotifyTable = async (): Promise<string | null> => {
  if (notifyTableCache !== undefined) return notifyTableCache;
  notifyTableCache = await firstExistingTable(NOTIFY_TABLE_CANDIDATES);
  return notifyTableCache;
};

const firstExistingTable = async (candidates: string[]): Promise<string | null> => {
  for (const table of candidates) {
    const { error } = await supabaseAdmin.from(table).select("id", { count: "exact", head: true }).limit(1);
    if (!error) return table;
  }
  return null;
};

const isMissingTableError = (err: unknown): boolean => {
  const msg =
    typeof err === "string"
      ? err
      : err && typeof err === "object" && "message" in err
        ? String((err as { message?: string }).message || "")
        : "";
  return msg.includes("Could not find the table") || msg.includes("relation") || msg.includes("does not exist");
};

const isMissingColumnError = (err: unknown): boolean => {
  const msg =
    typeof err === "string"
      ? err
      : err && typeof err === "object" && "message" in err
        ? String((err as { message?: string }).message || "")
        : "";
  return msg.includes("Could not find the") && msg.includes("column");
};

const parseIsoDate = (v: string): string => {
  const t = new Date(String(v || "")).getTime();
  if (Number.isNaN(t)) return "";
  return new Date(t).toISOString().slice(0, 10);
};

const escapeHtml = (v: string): string =>
  String(v || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const isAppAdminRole = (roleRaw: unknown): boolean => {
  const role = String(roleRaw || "").trim().toLowerCase();
  return role === "super_admin" || role === "technician" || role === "iiw_instructor" || role === "iiw_admin";
};

const BAN_LEVELS = {
  YELLOW: "yellow_warning",
  DAY15: "15_day_ban",
  SEMESTER: "semester_ban",
  PERMANENT: "permanent_ban"
} as const;

const DELAY_PICKUP_QUEUE_WINDOW_MIN = 32;
const DELAY_MINOR_LATE_MAX_MIN = 30;
const DELAY_SOFT_MAJOR_LATE_YELLOW_CAP = 1;

const BAN_TABLE_CANDIDATES = ["bans", "user_bans", "restrictions_bans"];
let banTableCache: string | null | undefined = undefined;

const resolveBanTable = async (): Promise<string | null> => {
  if (banTableCache !== undefined) return banTableCache;
  banTableCache = await firstExistingTable(BAN_TABLE_CANDIDATES);
  return banTableCache;
};

const formatBanStageForUser = (levelRaw: string): string => {
  const l = String(levelRaw || "").toLowerCase();
  if (l.includes("yellow")) return "Yellow Warning";
  if (l.includes("15")) return "15 Day Suspension";
  if (l.includes("7")) return "7 Day Suspension";
  if (l.includes("semester")) return "Semester Suspension";
  if (l.includes("permanent")) return "Permanent Ban";
  return l || "Penalty";
};

const formatBanStageForAdmin = (levelRaw: string): string => {
  const l = String(levelRaw || "").toLowerCase();
  if (l.includes("yellow")) return "Sarı Uyarı";
  if (l.includes("15")) return "15 Gün Askı";
  if (l.includes("7")) return "7 Gün Askı";
  if (l.includes("semester")) return "Dönemlik Askı";
  if (l.includes("permanent")) return "Kalıcı Yasak";
  return levelRaw || "Ceza";
};

const normalizeBool = (raw: unknown): boolean => {
  if (typeof raw === "boolean") return raw;
  const s = String(raw || "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
};

const canOperateLevel5Equipment = (profile: Record<string, unknown>): boolean => {
  const role = String(profile.role || "").trim().toLowerCase();
  return role === "super_admin" || role === "technician" || normalizeBool(profile.senior_flag);
};

const getSemesterEndDateIso = (): string => {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  if (month <= 6) return new Date(year, 5, 30, 23, 59, 59, 0).toISOString();
  return new Date(year + 1, 0, 31, 23, 59, 59, 0).toISOString();
};

const safeDiffMinutes = (aIso: string, bIso: string): number => {
  const a = new Date(String(aIso || "")).getTime();
  const b = new Date(String(bIso || "")).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return (a - b) / 60000;
};

type DashboardLoan = {
  kind?: "equipment" | "studio_key";
  eqId: string;
  eqDisplayId: string;
  name: string;
  due: string;
  overdue: boolean;
  msLeft: number | null;
  resGroupId: string;
  handover: string;
  resEnd: string;
};

const resolveStudioCanonicalKey = (raw: unknown): string => {
  const s = String(raw ?? "").trim().toUpperCase();
  if (!s) return "";
  if (s === "GREEN" || s.includes("GREEN")) return "GREEN";
  if (s === "RED" || s.includes("RED")) return "RED";
  if (s === "BLUE" || s.includes("BLUE")) return "BLUE";
  if (s === "PODCAST" || s.includes("PODCAST")) return "PODCAST";
  if (s === "DUBBING" || s.includes("DUBBING")) return "DUBBING";
  return "";
};

const studioKeyCodeFromCanonical = (raw: unknown): string => {
  const key = resolveStudioCanonicalKey(raw);
  if (key === "GREEN") return "GKEY-01";
  if (key === "RED") return "RKEY-01";
  if (key === "BLUE") return "BKEY-01";
  if (key === "PODCAST") return "PKEY-01";
  if (key === "DUBBING") return "DKEY-01";
  return "";
};

type DashboardPenalty = {
  id: string;
  ban_level: string;
  stageLabel: string;
  reason: string;
  banned_at: string;
  expires_at: string;
  active: boolean;
  remainingMs: number | null;
  isYellowWarning: boolean;
  isHardBan: boolean;
};

type DashboardExtras = {
  loans: DashboardLoan[];
  penalties: DashboardPenalty[];
  appBlocked: boolean;
  blockReason: string;
};

const listUserBanRows = async (profileId: string, email: string): Promise<Record<string, unknown>[]> => {
  const table = await resolveBanTable();
  if (!table) return [];
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const run = async (userId: string) => {
    if (!userId) return;
    const q = await supabaseAdmin
      .from(table)
      .select("*")
      .eq("user_id", userId)
      .order("banned_at", { ascending: false })
      .limit(200);
    if (q.error) {
      if (isMissingTableError(q.error)) return;
      throw new Error(q.error.message);
    }
    for (const r of q.data ?? []) {
      const id = String((r as Record<string, unknown>).id || "");
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      rows.push(r as Record<string, unknown>);
    }
  };
  await run(profileId);
  if (!rows.length) await run(email);
  return rows.sort((a, b) => new Date(String(b.banned_at || "")).getTime() - new Date(String(a.banned_at || "")).getTime());
};

const getUserDashboardExtrasForProfile = async (
  profile: { id?: string | null; email?: string | null; role?: string | null }
): Promise<DashboardExtras> => {
  const profileId = String(profile.id || "").trim();
  const email = String(profile.email || "").trim().toLowerCase();
  const ownerFilter = profileId && email
    ? `requester_profile_id.eq.${profileId},requester_email.eq.${email}`
    : profileId
      ? `requester_profile_id.eq.${profileId}`
      : `requester_email.eq.${email}`;
  const now = Date.now();

  const [eqLoanRowsRes, stLoanRowsRes] = await Promise.all([
    supabaseAdmin
      .from("equipment_reservations")
      .select("id,equipment_item_id,start_at,end_at,status")
      .or(ownerFilter)
      .in("status", EQUIPMENT_ON_LOAN_RES_STATUSES)
      .order("end_at", { ascending: true }),
    supabaseAdmin
      .from("studio_reservations")
      .select("id,studio_id,start_at,end_at,status")
      .or(ownerFilter)
      .eq("status", STUDIO_PICKED_STATUS)
      .order("end_at", { ascending: true })
  ]);
  if (eqLoanRowsRes.error) throw new Error(eqLoanRowsRes.error.message);
  if (stLoanRowsRes.error) throw new Error(stLoanRowsRes.error.message);

  const eqLoanRows = (eqLoanRowsRes.data ?? []) as Record<string, unknown>[];
  const stLoanRows = (stLoanRowsRes.data ?? []) as Record<string, unknown>[];

  const eqIds = Array.from(new Set(eqLoanRows.map((r) => String(r.equipment_item_id || "")).filter(Boolean)));
  const studioIds = Array.from(new Set(stLoanRows.map((r) => String(r.studio_id || "")).filter(Boolean)));
  const [eqMetaRes, studiosRes] = await Promise.all([
    eqIds.length
      ? supabaseAdmin.from("equipment_items").select("id,name,equipment_id").in("id", eqIds)
      : Promise.resolve({ data: [], error: null }),
    studioIds.length
      ? supabaseAdmin.from("studios").select("id,name").in("id", studioIds)
      : Promise.resolve({ data: [], error: null })
  ]);
  if (eqMetaRes.error) throw new Error(eqMetaRes.error.message);
  if (studiosRes.error) throw new Error(studiosRes.error.message);

  const eqMetaById = new Map(
    ((eqMetaRes.data ?? []) as Record<string, unknown>[]).map((r) => [
      String(r.id || ""),
      {
        name: String(r.name || r.id || ""),
        code: String(r.equipment_id || r.id || "")
      }
    ])
  );
  const studioNameById = new Map(
    ((studiosRes.data ?? []) as Record<string, unknown>[]).map((r) => [String(r.id || ""), String(r.name || r.id || "")])
  );

  const equipmentLoans: DashboardLoan[] = eqLoanRows.map((r) => {
    const due = String(r.end_at || "");
    const dueMs = due ? new Date(due).getTime() : NaN;
    const meta = eqMetaById.get(String(r.equipment_item_id || "")) || { name: String(r.equipment_item_id || ""), code: String(r.equipment_item_id || "") };
    return {
      kind: "equipment",
      eqId: String(r.equipment_item_id || ""),
      eqDisplayId: String(meta.code || r.equipment_item_id || ""),
      name: String(meta.name || r.equipment_item_id || ""),
      due,
      overdue: !Number.isNaN(dueMs) && dueMs < now,
      msLeft: Number.isNaN(dueMs) ? null : dueMs - now,
      resGroupId: String(r.id || ""),
      handover: String(r.start_at || ""),
      resEnd: due
    };
  });

  const studioLoans: DashboardLoan[] = stLoanRows.map((r) => {
    const due = String(r.end_at || "");
    const dueMs = due ? new Date(due).getTime() : NaN;
    const studioId = String(r.studio_id || "");
    const studioName = studioNameById.get(studioId) || studioId || "Studio";
    const keyCode = studioKeyCodeFromCanonical(`${studioId} ${studioName}`) || "STUDIO-KEY";
    return {
      kind: "studio_key",
      eqId: studioId,
      eqDisplayId: keyCode,
      name: `${studioName} Studio Key`,
      due,
      overdue: !Number.isNaN(dueMs) && dueMs < now,
      msLeft: Number.isNaN(dueMs) ? null : dueMs - now,
      resGroupId: String(r.id || ""),
      handover: String(r.start_at || ""),
      resEnd: due
    };
  });

  const loans: DashboardLoan[] = [...equipmentLoans, ...studioLoans].sort((a, b) => {
    const am = new Date(String(a.due || "")).getTime();
    const bm = new Date(String(b.due || "")).getTime();
    if (Number.isNaN(am) && Number.isNaN(bm)) return 0;
    if (Number.isNaN(am)) return 1;
    if (Number.isNaN(bm)) return -1;
    return am - bm;
  });

  const penaltiesRaw = await listUserBanRows(profileId, email);
  const penalties: DashboardPenalty[] = [];
  const table = await resolveBanTable();
  for (const b of penaltiesRaw) {
    const id = String(b.id || "");
    const banLevel = String(b.ban_level || "");
    const isYellowWarning = banLevel.toLowerCase().includes("yellow");
    const expiresAt = String(b.expires_at || "");
    const expMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
    const activeRaw = normalizeBool(b.active);
    const isExpired = !Number.isNaN(expMs) && expMs < now;
    const active = activeRaw && !isExpired;
    const remainingMs = Number.isNaN(expMs) ? null : Math.max(0, expMs - now);
    if (activeRaw && isExpired && table && id) {
      await supabaseAdmin.from(table).update({ active: false }).eq("id", id);
    }
    penalties.push({
      id,
      ban_level: banLevel,
      stageLabel: formatBanStageForUser(banLevel),
      reason: String(b.reason || ""),
      banned_at: String(b.banned_at || ""),
      expires_at: expiresAt,
      active,
      remainingMs,
      isYellowWarning,
      isHardBan: active && !isYellowWarning
    });
  }

  const hasOverdue = loans.some((l) => l.overdue);
  const hasBlockingPenalty = penalties.some((p) => p.active && !p.isYellowWarning);
  const isAdmin = isAppAdminRole(profile.role);
  const appBlocked = !isAdmin && (hasOverdue || hasBlockingPenalty);
  let blockReason = "";
  if (hasOverdue && hasBlockingPenalty) blockReason = "overdue_and_penalty";
  else if (hasOverdue) blockReason = "overdue";
  else if (hasBlockingPenalty) blockReason = "penalty";

  return { loans, penalties, appBlocked, blockReason };
};

const assertUserNotAppBlocked = async (profile: { id?: string | null; email?: string | null; role?: string | null }) => {
  if (isAppAdminRole(profile.role)) return;
  const ex = await getUserDashboardExtrasForProfile(profile);
  if (ex.appBlocked) {
    throw new Error("Your account is restricted (overdue equipment or an active non-warning penalty). Please visit the equipment desk. New bookings are disabled until this is resolved.");
  }
};

const countPriorHardLateBans = (penalties: DashboardPenalty[]): number =>
  penalties.filter((p) => p.ban_level === BAN_LEVELS.DAY15).length;

const countMajorLateSoftWarnings = (penalties: DashboardPenalty[]): number =>
  penalties.filter((p) =>
    p.ban_level === BAN_LEVELS.YELLOW &&
    String(p.reason || "").toLowerCase().includes("major") &&
    String(p.reason || "").toLowerCase().includes("late")
  ).length;

const hasPickupQueuedSoon = async (
  itemId: string,
  returnAtIso: string,
  windowMin: number,
  currentReservationId: string,
  currentOwnerProfileId: string,
  currentOwnerEmail: string
): Promise<boolean> => {
  const endMs = new Date(returnAtIso).getTime() + windowMin * 60000;
  const windowEndIso = new Date(endMs).toISOString();
  const q = await supabaseAdmin
    .from("equipment_reservations")
    .select("id,requester_profile_id,requester_email,start_at,status")
    .eq("equipment_item_id", itemId)
    .in("status", EQUIPMENT_ACTIVE_RES_STATUSES)
    .gt("start_at", returnAtIso)
    .lte("start_at", windowEndIso)
    .neq("id", currentReservationId)
    .order("start_at", { ascending: true })
    .limit(20);
  if (q.error) throw new Error(q.error.message);
  const rows = (q.data ?? []) as Record<string, unknown>[];
  return rows.some((r) => {
    const pid = String(r.requester_profile_id || "");
    const em = String(r.requester_email || "").toLowerCase();
    const sameById = currentOwnerProfileId && pid && pid === currentOwnerProfileId;
    const sameByEmail = currentOwnerEmail && em && em === currentOwnerEmail;
    return !(sameById || sameByEmail);
  });
};

const applyLateReturnPenalty = async (payload: {
  reservationId: string;
  itemId: string;
  itemName: string;
  userId: string;
  userName: string;
  userEmail: string;
  dueAt: string;
  returnAt: string;
  actorId: string;
}): Promise<{ action: string; is_ban: boolean; reason: string; expires_at: string; level?: string }> => {
  const table = await resolveBanTable();
  if (!table) return { action: "penalty_table_missing", is_ban: false, reason: "Penalty table is not configured.", expires_at: "" };
  const ownerId = String(payload.userId || payload.userEmail || "").trim().toLowerCase();
  if (!ownerId) return { action: "skip_no_user", is_ban: false, reason: "Missing user identity.", expires_at: "" };
  const diffMin = safeDiffMinutes(payload.returnAt, payload.dueAt);
  if (diffMin <= 0) return { action: "clean_return", is_ban: false, reason: "On time.", expires_at: "" };

  const extras = await getUserDashboardExtrasForProfile({ id: ownerId, email: payload.userEmail, role: "" });
  const priorHardDelays = countPriorHardLateBans(extras.penalties);
  const priorMajorSoftYellows = countMajorLateSoftWarnings(extras.penalties);

  const majorLate = diffMin > DELAY_MINOR_LATE_MAX_MIN;
  const queuedPickupSoon = majorLate
    ? await hasPickupQueuedSoon(
      payload.itemId,
      payload.returnAt,
      DELAY_PICKUP_QUEUE_WINDOW_MIN,
      payload.reservationId,
      ownerId,
      payload.userEmail.toLowerCase()
    )
    : false;

  let banLevel = "";
  let banReason = "";
  let expiresAt = "";
  let isActualBan = false;

  const applyHardLate = () => {
    if (priorHardDelays >= 1) {
      banLevel = BAN_LEVELS.SEMESTER;
      banReason = "Repeated late-return violation. Semester suspension.";
      expiresAt = getSemesterEndDateIso();
      isActualBan = true;
      return;
    }
    const exp = new Date();
    exp.setDate(exp.getDate() + 15);
    banLevel = BAN_LEVELS.DAY15;
    banReason = "Late return. 15-day suspension.";
    expiresAt = exp.toISOString();
    isActualBan = true;
  };

  if (majorLate) {
    if (queuedPickupSoon) applyHardLate();
    else if (priorMajorSoftYellows >= DELAY_SOFT_MAJOR_LATE_YELLOW_CAP) applyHardLate();
    else {
      banLevel = BAN_LEVELS.YELLOW;
      banReason = "Yellow Warning: Late (major, no pickup queue).";
      isActualBan = false;
    }
  } else {
    banLevel = BAN_LEVELS.YELLOW;
    banReason = "Yellow Warning: Late.";
    isActualBan = false;
  }

  const banPayload = {
    id: randomUUID(),
    user_id: ownerId,
    user_name: payload.userName || payload.userEmail,
    ban_level: banLevel,
    reason: banReason,
    banned_by: payload.actorId || "SYSTEM",
    banned_at: payload.returnAt,
    expires_at: expiresAt || null,
    active: isActualBan,
    notes: [
      `policy=late_return`,
      `major=${majorLate ? "1" : "0"}`,
      `queued=${queuedPickupSoon ? "1" : "0"}`,
      `item=${payload.itemId}`,
      `res=${payload.reservationId}`
    ].join(";")
  };
  const ins = await supabaseAdmin.from(table).insert(banPayload).select("id").single();
  if (ins.error) throw new Error(ins.error.message);
  return { action: banLevel, level: banLevel, is_ban: isActualBan, reason: banReason, expires_at: expiresAt };
};

const TR_FIXED_PUBLIC_HOLIDAYS = new Set(["01-01", "04-23", "05-01", "05-19", "07-15", "08-30", "10-29"]);
const TR_RELIGIOUS_HOLIDAYS_BY_YEAR: Record<string, string[]> = {
  "2025": ["2025-03-30", "2025-03-31", "2025-04-01", "2025-04-02", "2025-06-06", "2025-06-07", "2025-06-08", "2025-06-09"],
  "2026": ["2026-03-19", "2026-03-20", "2026-03-21", "2026-03-22", "2026-05-26", "2026-05-27", "2026-05-28", "2026-05-29", "2026-05-30"],
  "2027": ["2027-03-08", "2027-03-09", "2027-03-10", "2027-03-11", "2027-05-16", "2027-05-17", "2027-05-18", "2027-05-19"]
};
const DEPOT_SLOT_DEFAULT_MAX_BOOKINGS = 4;
const DEPOT_SLOT_CONFIG_KEY = "depot_slot_max_bookings";
const DEPOT_SLOT_CONFIG_CACHE_MS = 60_000;
let depotSlotConfigCache: { value: number; ts: number } | null = null;

const toIsoDayLocal = (d: Date): string => {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const isTurkeyPublicHoliday = (d: Date): boolean => {
  const monthDay = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (TR_FIXED_PUBLIC_HOLIDAYS.has(monthDay)) return true;
  const y = String(d.getFullYear());
  const dynamic = TR_RELIGIOUS_HOLIDAYS_BY_YEAR[y] || [];
  return dynamic.includes(toIsoDayLocal(d));
};

const hasPublicHolidayInRange = (startAt: string, endAt: string): boolean => {
  const s = new Date(String(startAt || ""));
  const e = new Date(String(endAt || ""));
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) return false;
  const cursor = new Date(s.getTime());
  cursor.setHours(0, 0, 0, 0);
  const last = new Date(e.getTime() - 1);
  last.setHours(0, 0, 0, 0);
  while (cursor <= last) {
    if (isTurkeyPublicHoliday(cursor)) return true;
    cursor.setDate(cursor.getDate() + 1);
  }
  return false;
};

const resolveDepotSlotMaxBookings = async (): Promise<number> => {
  const now = Date.now();
  if (depotSlotConfigCache && now - depotSlotConfigCache.ts <= DEPOT_SLOT_CONFIG_CACHE_MS) {
    return depotSlotConfigCache.value;
  }
  const q = await supabaseAdmin
    .from("app_config")
    .select("value")
    .eq("key", DEPOT_SLOT_CONFIG_KEY)
    .limit(1)
    .maybeSingle();
  if (q.error) {
    if (isMissingTableError(q.error) || isMissingColumnError(q.error)) {
      depotSlotConfigCache = { value: DEPOT_SLOT_DEFAULT_MAX_BOOKINGS, ts: now };
      return DEPOT_SLOT_DEFAULT_MAX_BOOKINGS;
    }
    throw new Error(q.error.message);
  }
  const rawNum = Number((q.data as Record<string, unknown> | null)?.value);
  const parsed = Number.isFinite(rawNum) && rawNum >= 1 ? Math.floor(rawNum) : DEPOT_SLOT_DEFAULT_MAX_BOOKINGS;
  depotSlotConfigCache = { value: parsed, ts: now };
  return parsed;
};

const floorToHalfHourUtc = (isoRaw: string): { slotStartIso: string; slotEndIso: string } | null => {
  const ms = new Date(String(isoRaw || "")).getTime();
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  const m = d.getUTCMinutes();
  d.setUTCMinutes(m < 30 ? 0 : 30, 0, 0);
  const slotStartIso = d.toISOString();
  const slotEndIso = new Date(d.getTime() + 30 * 60 * 1000).toISOString();
  return { slotStartIso, slotEndIso };
};

const slotGroupKey = (row: Record<string, unknown>): string => {
  const id = String(row.id || "").trim();
  const ownerId = String(row.requester_profile_id || "").trim().toLowerCase();
  const ownerEmail = String(row.requester_email || "").trim().toLowerCase();
  const owner = ownerId || ownerEmail || `res:${id}`;
  const startAt = String(row.start_at || "");
  const endAt = String(row.end_at || "");
  return `${owner}|${startAt}|${endAt}`;
};

const getDepotSlotUsage = async (
  slotStartIso: string,
  slotEndIso: string,
  excludeReservationIds: Set<string>
): Promise<{ pickupCount: number; returnCount: number; totalDistinct: number }> => {
  const selectCols = "id,requester_profile_id,requester_email,start_at,end_at";
  const [pickupRes, returnRes] = await Promise.all([
    supabaseAdmin
      .from("equipment_reservations")
      .select(selectCols)
      .in("status", EQUIPMENT_ACTIVE_RES_STATUSES)
      .gte("start_at", slotStartIso)
      .lt("start_at", slotEndIso),
    supabaseAdmin
      .from("equipment_reservations")
      .select(selectCols)
      .in("status", EQUIPMENT_ACTIVE_RES_STATUSES)
      .gte("end_at", slotStartIso)
      .lt("end_at", slotEndIso)
  ]);
  if (pickupRes.error) throw new Error(pickupRes.error.message);
  if (returnRes.error) throw new Error(returnRes.error.message);

  const pickup = new Set<string>();
  const returns = new Set<string>();
  for (const r of (pickupRes.data ?? []) as Record<string, unknown>[]) {
    const id = String(r.id || "").trim();
    if (id && excludeReservationIds.has(id)) continue;
    pickup.add(slotGroupKey(r));
  }
  for (const r of (returnRes.data ?? []) as Record<string, unknown>[]) {
    const id = String(r.id || "").trim();
    if (id && excludeReservationIds.has(id)) continue;
    returns.add(slotGroupKey(r));
  }
  const all = new Set<string>([...pickup, ...returns]);
  return {
    pickupCount: pickup.size,
    returnCount: returns.size,
    totalDistinct: all.size
  };
};

const formatDepotSlotLabel = (slotStartIso: string): string => {
  const ms = new Date(String(slotStartIso || "")).getTime();
  if (Number.isNaN(ms)) return slotStartIso;
  const str = new Date(ms).toLocaleString("tr-TR", {
    timeZone: "Europe/Istanbul",
    hour12: false,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
  const parts = String(str || "").split(" ");
  if (parts.length < 2) return str;
  const ddmm = String(parts[0] || "")
    .split(".")
    .slice(0, 2)
    .join(".");
  return `${ddmm} / ${parts[1]}`;
};

const buildDepotSlotCapacityError = (
  slotStartIso: string,
  role: "handover" | "return" | "both",
  usage: { pickupCount: number; returnCount: number; totalDistinct: number },
  maxBookings: number
): string => {
  const slotLabel = formatDepotSlotLabel(slotStartIso);
  const roleLabel = role === "handover" ? "teslim" : role === "return" ? "iade" : "teslim/iade";
  return (
    `Depo ${roleLabel} yoğunluğu nedeniyle ${slotLabel} slotu dolu. ` +
    `Bu 30 dakikalık pencerede toplam ${usage.totalDistinct}/${maxBookings} işlem var ` +
    `(teslim: ${usage.pickupCount}, iade: ${usage.returnCount}). Lütfen farklı bir saat seçin.`
  );
};

const assertDepotSlotCapacity = async (params: {
  startAt: string;
  endAt: string;
  excludeReservationId?: string;
  checkStart?: boolean;
  checkEnd?: boolean;
}) => {
  const checkStart = params.checkStart !== false;
  const checkEnd = params.checkEnd !== false;
  if (!checkStart && !checkEnd) return;
  const startSlot = floorToHalfHourUtc(params.startAt);
  const endSlot = floorToHalfHourUtc(params.endAt);
  if (!startSlot || !endSlot) return;
  const maxBookings = await resolveDepotSlotMaxBookings();
  if (!Number.isFinite(maxBookings) || maxBookings <= 0) return;

  const exclude = new Set<string>();
  const excludeId = String(params.excludeReservationId || "").trim();
  if (excludeId) exclude.add(excludeId);

  const sameSlot = startSlot.slotStartIso === endSlot.slotStartIso;
  if (checkStart && checkEnd && sameSlot) {
    const usage = await getDepotSlotUsage(startSlot.slotStartIso, startSlot.slotEndIso, exclude);
    if (usage.totalDistinct >= maxBookings) {
      throw new Error(buildDepotSlotCapacityError(startSlot.slotStartIso, "both", usage, maxBookings));
    }
    return;
  }
  if (checkStart) {
    const usageStart = await getDepotSlotUsage(startSlot.slotStartIso, startSlot.slotEndIso, exclude);
    if (usageStart.totalDistinct >= maxBookings) {
      throw new Error(buildDepotSlotCapacityError(startSlot.slotStartIso, "handover", usageStart, maxBookings));
    }
  }
  if (checkEnd) {
    const usageEnd = await getDepotSlotUsage(endSlot.slotStartIso, endSlot.slotEndIso, exclude);
    if (usageEnd.totalDistinct >= maxBookings) {
      throw new Error(buildDepotSlotCapacityError(endSlot.slotStartIso, "return", usageEnd, maxBookings));
    }
  }
};

const listOverdueEquipmentRows = async (): Promise<Array<{
  id: string;
  reservation_id: string;
  name: string;
  studentName: string;
  studentId: string;
  emailHint: string;
  userId: string;
  userEmail: string;
  due: string;
}>> => {
  const nowIso = new Date().toISOString();
  const activeForOverdue = Array.from(new Set(["approved", ...EQUIPMENT_ON_LOAN_RES_STATUSES]));
  const eqRes = await supabaseAdmin
    .from("equipment_reservations")
    .select("id,equipment_item_id,requester_name,requester_profile_id,requester_email,end_at,status")
    .in("status", activeForOverdue)
    .lt("end_at", nowIso)
    .order("end_at", { ascending: true });
  if (eqRes.error) throw new Error(eqRes.error.message);
  const rows = (eqRes.data ?? []) as Record<string, unknown>[];
  const eqIds = Array.from(new Set(rows.map((r) => String(r.equipment_item_id || "")).filter(Boolean)));
  const items = eqIds.length
    ? await supabaseAdmin.from("equipment_items").select("id,name").in("id", eqIds)
    : { data: [], error: null };
  if (items.error) throw new Error(items.error.message);
  const nameById = new Map(((items.data ?? []) as Record<string, unknown>[]).map((r) => [String(r.id || ""), String(r.name || r.id || "")]));
  return rows.map((r) => {
    const eqId = String(r.equipment_item_id || "");
    return {
      id: eqId,
      reservation_id: String(r.id || ""),
      name: nameById.get(eqId) || eqId,
      studentName: String(r.requester_name || r.requester_email || ""),
      studentId: String(r.requester_profile_id || r.requester_email || ""),
      emailHint: String(r.requester_email || ""),
      userId: String(r.requester_profile_id || r.requester_email || ""),
      userEmail: String(r.requester_email || ""),
      due: String(r.end_at || "")
    };
  });
};

const sendOverdueReminderEmail = async (toEmail: string, payload: { name: string; id: string; due: string }): Promise<void> => {
  const apiKey = String(env.RESEND_API_KEY || "").trim();
  const from = String(env.OTP_EMAIL_FROM || "").trim();
  if (!apiKey || !from) {
    throw new Error("Overdue reminder mail is not configured. Missing RESEND_API_KEY or OTP_EMAIL_FROM.");
  }
  const appName = String(env.OTP_APP_NAME || "BUKit").trim();
  const dueRaw = String(payload.due || "");
  const dueMs = new Date(dueRaw).getTime();
  const dueLabel = Number.isNaN(dueMs)
    ? dueRaw
    : new Date(dueMs).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", hour12: false });
  const subject = `[${appName}] Iade hatirlatmasi / Equipment return reminder`;
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;line-height:1.45;color:#111827">
      <p><strong>TR</strong></p>
      <p>Merhaba,</p>
      <p>Asagidaki ekipmanin iade suresi <strong>gecmistir</strong>:</p>
      <p><strong>${escapeHtml(payload.name)}</strong> (${escapeHtml(payload.id)})<br>Son iade: ${escapeHtml(dueLabel)}</p>
      <p>Lutfen en kisa surede ekipman ofisine iade ediniz.</p>
      <hr style="border:none;border-top:1px solid #ddd;margin:12px 0;">
      <p><strong>EN</strong></p>
      <p>Hello,</p>
      <p>This is a reminder that the following equipment is <strong>overdue</strong> for return:</p>
      <p><strong>${escapeHtml(payload.name)}</strong> (${escapeHtml(payload.id)})<br>Due: ${escapeHtml(dueLabel)}</p>
      <p>Please return it to the equipment office as soon as possible.</p>
    </div>
  `;
  const text =
    `TR: Iade suresi gecen ekipman: ${payload.name} (${payload.id})\n` +
    `Son iade: ${dueLabel}\n\n` +
    `EN: Overdue equipment: ${payload.name} (${payload.id})\n` +
    `Due: ${dueLabel}`;

  const body: Record<string, unknown> = { from, to: [toEmail], subject, html, text };
  if (env.OTP_EMAIL_REPLY_TO) body.reply_to = env.OTP_EMAIL_REPLY_TO;
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const raw = await resp.text();
    throw new Error(`Resend send failed (${resp.status}): ${raw || resp.statusText}`);
  }
};

const sendEquipmentAvailableNotifyEmail = async (
  toEmail: string,
  payload: { name: string; code: string; availableAtIso: string }
): Promise<void> => {
  const apiKey = String(env.RESEND_API_KEY || "").trim();
  const from = String(env.OTP_EMAIL_FROM || "").trim();
  if (!apiKey || !from) {
    throw new Error("Notify mail is not configured. Missing RESEND_API_KEY or OTP_EMAIL_FROM.");
  }
  const appName = String(env.OTP_APP_NAME || "BUKit").trim();
  const ts = new Date(String(payload.availableAtIso || "")).getTime();
  const availableAtLabel = Number.isNaN(ts)
    ? String(payload.availableAtIso || "")
    : new Date(ts).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", hour12: false });
  const title = String(payload.name || payload.code || "Equipment").trim();
  const code = String(payload.code || "").trim();
  const subject = `[${appName}] Ekipman musait / Equipment available: ${title}`;
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;line-height:1.45;color:#111827">
      <p><strong>TR</strong></p>
      <p>Merhaba,</p>
      <p>Bildirim istediginiz ekipman su an musait:</p>
      <p><strong>${escapeHtml(title)}</strong>${code ? ` (${escapeHtml(code)})` : ""}<br>Müsait oldugu saat: ${escapeHtml(availableAtLabel)}</p>
      <p>Rezervasyon icin BookDeck'e giris yapabilirsiniz.</p>
      <hr style="border:none;border-top:1px solid #ddd;margin:12px 0;">
      <p><strong>EN</strong></p>
      <p>Hello,</p>
      <p>The equipment you requested notifications for is now available:</p>
      <p><strong>${escapeHtml(title)}</strong>${code ? ` (${escapeHtml(code)})` : ""}<br>Available at: ${escapeHtml(availableAtLabel)}</p>
      <p>You can sign in to BookDeck to place your reservation.</p>
    </div>
  `;
  const text =
    `TR: Bildirim istediginiz ekipman su an musait: ${title}${code ? ` (${code})` : ""}\n` +
    `Saat: ${availableAtLabel}\n\n` +
    `EN: The equipment you requested notifications for is now available: ${title}${code ? ` (${code})` : ""}\n` +
    `Available at: ${availableAtLabel}`;
  const body: Record<string, unknown> = { from, to: [toEmail], subject, html, text };
  if (env.OTP_EMAIL_REPLY_TO) body.reply_to = env.OTP_EMAIL_REPLY_TO;
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const raw = await resp.text();
    throw new Error(`Resend send failed (${resp.status}): ${raw || resp.statusText}`);
  }
};

const parsePdfDataUrl = (raw: string): { mimeType: string; base64: string } | null => {
  const value = String(raw || "").trim();
  if (!value) return null;
  const match = value.match(/^data:(application\/pdf)(?:;[^,]*)?;base64,([\s\S]+)$/i);
  if (!match) return null;
  const mimeType = String(match[1] || "application/pdf").toLowerCase();
  const base64 = String(match[2] || "").replace(/\s+/g, "");
  if (!base64) return null;
  return { mimeType, base64 };
};

const formatMailDateTimeTR = (iso: string): string => {
  const ms = new Date(String(iso || "")).getTime();
  if (Number.isNaN(ms)) return String(iso || "");
  return new Date(ms).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", hour12: false });
};

const sendCheckoutPdfAttachmentEmail = async (
  toEmail: string,
  payload: {
    kind: "equipment" | "studio";
    reservationId: string;
    studentName: string;
    startAt: string;
    endAt: string;
    pdfDataUrl: string;
    studioName?: string;
  }
): Promise<void> => {
  const apiKey = String(env.RESEND_API_KEY || "").trim();
  const from = String(env.OTP_EMAIL_FROM || "").trim();
  if (!apiKey || !from) {
    throw new Error("Checkout PDF mail is not configured. Missing RESEND_API_KEY or OTP_EMAIL_FROM.");
  }
  const pdf = parsePdfDataUrl(payload.pdfDataUrl);
  if (!pdf) {
    throw new Error("Checkout PDF is not a valid base64 data URL.");
  }
  const appName = String(env.OTP_APP_NAME || "BUKit").trim();
  const startLabel = formatMailDateTimeTR(payload.startAt);
  const endLabel = formatMailDateTimeTR(payload.endAt);
  const reservationId = String(payload.reservationId || "").trim();
  const studentName = String(payload.studentName || "").trim();
  const scopeLabelTr = payload.kind === "studio" ? "Stüdyo kullanım" : "Ekipman teslim";
  const scopeLabelEn = payload.kind === "studio" ? "Studio usage" : "Equipment handover";
  const studioLine = payload.kind === "studio" && payload.studioName
    ? `<p><strong>Stüdyo / Studio:</strong> ${escapeHtml(String(payload.studioName || ""))}</p>`
    : "";
  const safeId = (reservationId || "reservation").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "reservation";
  const filename = payload.kind === "studio"
    ? `studio-usage-form-${safeId}.pdf`
    : `equipment-handover-form-${safeId}.pdf`;
  const subject = `[${appName}] ${scopeLabelTr} formu / ${scopeLabelEn} form`;
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;line-height:1.45;color:#111827">
      <p><strong>TR</strong></p>
      <p>Merhaba${studentName ? ` ${escapeHtml(studentName)}` : ""},</p>
      <p>Rezervasyonunuz için ${scopeLabelTr.toLowerCase()} PDF formu ektedir.</p>
      <p><strong>Rezervasyon ID:</strong> ${escapeHtml(reservationId || "-")}</p>
      <p><strong>Teslim:</strong> ${escapeHtml(startLabel)}<br><strong>İade:</strong> ${escapeHtml(endLabel)}</p>
      ${studioLine}
      <hr style="border:none;border-top:1px solid #ddd;margin:12px 0;">
      <p><strong>EN</strong></p>
      <p>Hello${studentName ? ` ${escapeHtml(studentName)}` : ""},</p>
      <p>Your ${scopeLabelEn.toLowerCase()} PDF form is attached for this reservation.</p>
      <p><strong>Reservation ID:</strong> ${escapeHtml(reservationId || "-")}</p>
      <p><strong>Checkout:</strong> ${escapeHtml(startLabel)}<br><strong>Return:</strong> ${escapeHtml(endLabel)}</p>
      ${studioLine}
    </div>
  `;
  const text =
    `TR: ${scopeLabelTr} formu ektedir.\n` +
    `Rezervasyon ID: ${reservationId || "-"}\n` +
    `Teslim: ${startLabel}\n` +
    `İade: ${endLabel}\n\n` +
    `EN: ${scopeLabelEn} form is attached.\n` +
    `Reservation ID: ${reservationId || "-"}\n` +
    `Checkout: ${startLabel}\n` +
    `Return: ${endLabel}`;
  const body: Record<string, unknown> = {
    from,
    to: [toEmail],
    subject,
    html,
    text,
    attachments: [
      {
        filename,
        content: pdf.base64
      }
    ]
  };
  if (env.OTP_EMAIL_REPLY_TO) body.reply_to = env.OTP_EMAIL_REPLY_TO;
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const raw = await resp.text();
    throw new Error(`Resend send failed (${resp.status}): ${raw || resp.statusText}`);
  }
};

const triggerNotifyForAvailableEquipment = async (
  item: { id?: unknown; equipment_id?: unknown; name?: unknown },
  logger?: { error: (payload: unknown, msg: string) => void }
): Promise<{ table: string | null; matched: number; sent: number; failed: number; keys: string[] }> => {
  const table = await resolveNotifyTable();
  const keys = buildNotifyGroupKeyCandidates(item);
  if (!table || !keys.length) return { table, matched: 0, sent: 0, failed: 0, keys };
  const pending = await supabaseAdmin
    .from(table)
    .select("email,group_key")
    .in("group_key", keys)
    .is("notified_at", null)
    .limit(2000);
  if (pending.error) {
    if (isMissingTableError(pending.error)) return { table: null, matched: 0, sent: 0, failed: 0, keys };
    throw new Error(pending.error.message);
  }
  const rows = (pending.data ?? []) as Array<Record<string, unknown>>;
  const grouped = new Map<string, Set<string>>();
  for (const row of rows) {
    const email = String(row.email || "").trim().toLowerCase();
    const groupKey = String(row.group_key || "").trim();
    if (!email || !email.includes("@") || !groupKey) continue;
    const set = grouped.get(email) || new Set<string>();
    set.add(groupKey);
    grouped.set(email, set);
  }
  let sent = 0;
  let failed = 0;
  const nowIso = new Date().toISOString();
  const eqName = String(item.name || item.equipment_id || item.id || "Equipment");
  const eqCode = String(item.equipment_id || item.id || "").trim();
  for (const [email, groupSet] of grouped.entries()) {
    const groupKeys = Array.from(groupSet.values());
    try {
      await sendEquipmentAvailableNotifyEmail(email, { name: eqName, code: eqCode, availableAtIso: nowIso });
      const marked = await supabaseAdmin
        .from(table)
        .update({ notified_at: nowIso })
        .eq("email", email)
        .in("group_key", groupKeys)
        .is("notified_at", null);
      if (marked.error && !isMissingTableError(marked.error)) {
        throw new Error(marked.error.message);
      }
      sent += 1;
    } catch (e) {
      failed += 1;
      if (logger) logger.error({ err: e, table, email, groupKeys, item }, "send available notify mail failed");
    }
  }
  return { table, matched: rows.length, sent, failed, keys };
};

const listAdminPenalties = async (): Promise<Array<{
  id: string;
  user_id: string;
  user_name: string;
  ban_level: string;
  stageLabel: string;
  reason: string;
  banned_at: string;
  expires_at: string;
  active: boolean;
  remainingMs: number | null;
  isSuspended: boolean;
  isYellow: boolean;
}>> => {
  const table = await resolveBanTable();
  if (!table) return [];
  const q = await supabaseAdmin.from(table).select("*").order("banned_at", { ascending: false }).limit(1000);
  if (q.error) {
    if (isMissingTableError(q.error)) return [];
    throw new Error(q.error.message);
  }
  const now = Date.now();
  const rows = (q.data ?? []) as Record<string, unknown>[];
  const out: Array<{
    id: string;
    user_id: string;
    user_name: string;
    ban_level: string;
    stageLabel: string;
    reason: string;
    banned_at: string;
    expires_at: string;
    active: boolean;
    remainingMs: number | null;
    isSuspended: boolean;
    isYellow: boolean;
  }> = [];
  for (const b of rows) {
    const id = String(b.id || "");
    const banLevel = String(b.ban_level || "");
    const isYellow = banLevel.toLowerCase().includes("yellow");
    const expiresAt = String(b.expires_at || "");
    const expMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
    const activeRaw = normalizeBool(b.active);
    const isExpired = !Number.isNaN(expMs) && expMs < now;
    const active = activeRaw && !isExpired;
    const remainingMs = Number.isNaN(expMs) ? null : Math.max(0, expMs - now);
    if (activeRaw && isExpired && id) {
      await supabaseAdmin.from(table).update({ active: false }).eq("id", id);
    }
    out.push({
      id,
      user_id: String(b.user_id || ""),
      user_name: String(b.user_name || ""),
      ban_level: banLevel,
      stageLabel: formatBanStageForAdmin(banLevel),
      reason: String(b.reason || ""),
      banned_at: String(b.banned_at || ""),
      expires_at: expiresAt,
      active,
      remainingMs,
      isSuspended: active && !isYellow,
      isYellow
    });
  }
  return out;
};

export const reservationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/me/dashboard-extras", { preHandler: requireAuth }, async (req, reply) => {
    const profile = getAuthProfile(req);
    try {
      const extras = await getUserDashboardExtrasForProfile({
        id: String(profile.id || ""),
        email: String(profile.email || "").toLowerCase(),
        role: String(profile.role || "")
      });
      return { ok: true, ...extras };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ ok: false, error: msg, loans: [], penalties: [], appBlocked: false, blockReason: "" });
    }
  });

  app.get("/me/bookings", { preHandler: requireAuth }, async (req, reply) => {
    const profile = getAuthProfile(req);
    const profileId = String(profile.id || "").trim();
    const email = String(profile.email || "").trim().toLowerCase();
    if (!profileId && !email) return reply.code(401).send({ ok: false, error: "Missing auth profile." });

    const ownerFilter = profileId && email
      ? `requester_profile_id.eq.${profileId},requester_email.eq.${email}`
      : profileId
        ? `requester_profile_id.eq.${profileId}`
        : `requester_email.eq.${email}`;

    const [eqRes, stRes] = await Promise.all([
      supabaseAdmin
        .from("equipment_reservations")
        .select("id,equipment_item_id,start_at,end_at,status")
        .or(ownerFilter)
        .order("start_at", { ascending: false }),
      supabaseAdmin
        .from("studio_reservations")
        .select("id,studio_id,start_at,end_at,status")
        .or(ownerFilter)
        .order("start_at", { ascending: false })
    ]);
    if (eqRes.error) return reply.code(500).send({ ok: false, error: eqRes.error.message });
    if (stRes.error) return reply.code(500).send({ ok: false, error: stRes.error.message });

    const eqRows = eqRes.data ?? [];
    const stRows = stRes.data ?? [];
    const eqIds = Array.from(new Set(eqRows.map((r) => String(r.equipment_item_id || "")).filter(Boolean)));
    const studioIds = Array.from(new Set(stRows.map((r) => String(r.studio_id || "")).filter(Boolean)));

    const [eqItemsRes, studiosRes] = await Promise.all([
      eqIds.length
        ? supabaseAdmin.from("equipment_items").select("id,name,equipment_id").in("id", eqIds)
        : Promise.resolve({ data: [], error: null }),
      studioIds.length
        ? supabaseAdmin.from("studios").select("id,name").in("id", studioIds)
        : Promise.resolve({ data: [], error: null })
    ]);
    if (eqItemsRes.error) return reply.code(500).send({ ok: false, error: eqItemsRes.error.message });
    if (studiosRes.error) return reply.code(500).send({ ok: false, error: studiosRes.error.message });

    const eqMetaById = new Map(
      (eqItemsRes.data ?? []).map((r) => [
        String(r.id || ""),
        {
          name: String(r.name || r.id || ""),
          code: String((r as Record<string, unknown>).equipment_id || r.id || "")
        }
      ])
    );
    const studioNameById = new Map((studiosRes.data ?? []).map((r) => [String(r.id || ""), String(r.name || r.id || "")]));

    const rows = [
      ...eqRows.map((r) => ({
        id: String(r.id || ""),
        type: "Equipment",
        item: (eqMetaById.get(String(r.equipment_item_id || "")) || { name: String(r.equipment_item_id || "") }).name,
        eqId: String(r.equipment_item_id || ""),
        eqDisplayId: (eqMetaById.get(String(r.equipment_item_id || "")) || { code: String(r.equipment_item_id || "") }).code,
        start: String(r.start_at || ""),
        end: String(r.end_at || ""),
        status: String(r.status || "")
      })),
      ...stRows.map((r) => ({
        id: String(r.id || ""),
        type: "Studio",
        item: studioNameById.get(String(r.studio_id || "")) || String(r.studio_id || ""),
        eqId: "",
        start: String(r.start_at || ""),
        end: String(r.end_at || ""),
        status: String(r.status || "")
      }))
    ].sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime());

    return { ok: true, data: rows };
  });

  app.post("/me/bookings/cancel", { preHandler: requireAuth }, async (req, reply) => {
    const profile = getAuthProfile(req);
    const parsed = myBookingCancelSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const id = String(parsed.data.id || "").trim();
    const type = String(parsed.data.type || "").trim().toLowerCase();
    if (!id) return reply.code(400).send({ ok: false, error: "Booking id required." });

    const isStudio = type.indexOf("studio") >= 0;
    const table = isStudio ? "studio_reservations" : "equipment_reservations";

    const existing = await supabaseAdmin
      .from(table)
      .select("id,status,requester_profile_id,requester_email")
      .eq("id", id)
      .limit(1)
      .maybeSingle();
    if (existing.error) return reply.code(500).send({ ok: false, error: existing.error.message });
    if (!existing.data) return reply.code(404).send({ ok: false, error: "Booking not found." });

    const ownerById = String(existing.data.requester_profile_id || "") === String(profile.id || "");
    const ownerByEmail =
      String(existing.data.requester_email || "").toLowerCase() === String(profile.email || "").toLowerCase();
    if (!ownerById && !ownerByEmail) {
      return reply.code(403).send({ ok: false, error: "Booking does not belong to current user." });
    }

    const status = String(existing.data.status || "").toLowerCase();
    const closedStatuses = isStudio ? STUDIO_CLOSED_RES_STATUSES : EQUIPMENT_CLOSED_RES_STATUSES;
    if (closedStatuses.includes(status)) {
      return { ok: true, already_closed: true, id, status };
    }

    const nextStatus = isStudio ? STUDIO_CANCELLED_STATUS : "cancelled";
    const updated = await supabaseAdmin
      .from(table)
      .update({
        status: nextStatus,
        reviewed_by: String(profile.email || ""),
        reviewed_at: new Date().toISOString()
      })
      .eq("id", id)
      .select("id,status")
      .single();
    if (updated.error) return reply.code(500).send({ ok: false, error: updated.error.message });
    return { ok: true, id: String(updated.data.id || id), status: String(updated.data.status || nextStatus) };
  });

  app.get("/admin/pending", { preHandler: requireRoles(ADMIN_ROLES) }, async (_, reply) => {
    const [eqRes, stRes] = await Promise.all([
      supabaseAdmin
        .from("equipment_reservations")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("studio_reservations")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: false })
    ]);
    if (eqRes.error) return reply.code(500).send({ ok: false, error: eqRes.error.message });
    if (stRes.error) return reply.code(500).send({ ok: false, error: stRes.error.message });
    const equipment = eqRes.data ?? [];
    const studios = stRes.data ?? [];
    const eqIds = Array.from(new Set(equipment.map((r) => String(r.equipment_item_id || "")).filter(Boolean)));
    const eqItems = eqIds.length
      ? await supabaseAdmin.from("equipment_items").select("id,name,category,equipment_id").in("id", eqIds)
      : { data: [], error: null };
    if (eqItems.error) return reply.code(500).send({ ok: false, error: eqItems.error.message });
    const eqMetaById = new Map(
      (eqItems.data ?? []).map((r) => [
        String(r.id || ""),
        {
          name: String(r.name || r.id || ""),
          type: String((r as Record<string, unknown>).category || ""),
          code: String((r as Record<string, unknown>).equipment_id || r.id || "")
        }
      ])
    );
    const list = [
      ...equipment.map((r) => ({
        id: String(r.id),
        kind: "equipment",
        userName: String(r.requester_name || r.requester_email || ""),
        email: String(r.requester_email || ""),
        phone: "",
        handoverLabel: String(r.start_at || ""),
        returnLabel: String(r.end_at || ""),
        purpose: String(r.note || ""),
        items: [
          {
            eqId: String(r.equipment_item_id || ""),
            eqCode: (eqMetaById.get(String(r.equipment_item_id || "")) || { code: String(r.equipment_item_id || "") }).code,
            name: (eqMetaById.get(String(r.equipment_item_id || "")) || { name: String(r.equipment_item_id || "") }).name,
            eqType: (eqMetaById.get(String(r.equipment_item_id || "")) || { type: "" }).type
          }
        ]
      })),
      ...studios.map((r) => ({
        id: String(r.id),
        kind: "studio",
        studio_id: String(r.studio_id || ""),
        studio_name: String(r.studio_id || ""),
        userName: String(r.requester_name || r.requester_email || ""),
        email: String(r.requester_email || ""),
        phone: "",
        handoverLabel: String(r.start_at || ""),
        returnLabel: String(r.end_at || ""),
        purpose: String(r.purpose || ""),
        items: []
      }))
    ];
    return { ok: true, equipment, studios, list, duplicateEqWarnings: [] };
  });

  app.post("/studio-reservations", { preHandler: requireAuth }, async (req, reply) => {
    const profile = getAuthProfile(req);
    const parsed = studioCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    try {
      await assertUserNotAppBlocked({
        id: String(profile.id || ""),
        email: String(profile.email || "").toLowerCase(),
        role: String(profile.role || "")
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(403).send({ ok: false, error: msg });
    }

    const { studio_id, start_at, end_at, purpose } = parsed.data;
    const s = new Date(start_at).getTime();
    const e = new Date(end_at).getTime();
    if (e <= s) return reply.code(400).send({ ok: false, error: "end_at must be after start_at." });
    if (hasPublicHolidayInRange(start_at, end_at)) {
      return reply.code(409).send({ ok: false, error: "Reservations are closed on official public holidays." });
    }

    const { data: studio, error: stErr } = await supabaseAdmin
      .from("studios")
      .select("*")
      .eq("id", studio_id)
      .limit(1)
      .maybeSingle();
    if (stErr) return reply.code(500).send({ ok: false, error: stErr.message });
    if (!studio) return reply.code(404).send({ ok: false, error: "Studio not found." });
    if (!canAccessStudioByPolicy(profile, studio as Record<string, unknown>)) {
      return reply.code(403).send({ ok: false, error: "Studio is not available for your account." });
    }

    const overlap = await supabaseAdmin
      .from("studio_reservations")
      .select("id")
      .eq("studio_id", studio_id)
      .in("status", STUDIO_ACTIVE_RES_STATUSES)
      .lt("start_at", end_at)
      .gt("end_at", start_at)
      .limit(1);
    if (overlap.error) return reply.code(500).send({ ok: false, error: overlap.error.message });
    if ((overlap.data ?? []).length > 0) {
      return reply.code(409).send({ ok: false, error: "Studio is not available in selected range." });
    }

    const payload = {
      studio_id,
      requester_profile_id: profile.id,
      requester_email: profile.email,
      requester_name: profile.full_name || profile.email,
      access_level: String(studio.access_level || "A"),
      status: isAdminRole(profile.role) ? STUDIO_APPROVED_STATUS : STUDIO_PENDING_STATUS,
      approval_required: !isAdminRole(profile.role),
      start_at,
      end_at,
      purpose
    };

    const { data, error } = await supabaseAdmin.from("studio_reservations").insert(payload).select("*").single();
    if (error) return reply.code(500).send({ ok: false, error: error.message });
    return { ok: true, data };
  });

  app.post("/equipment-reservations", { preHandler: requireAuth }, async (req, reply) => {
    const profile = getAuthProfile(req);
    const parsed = equipmentCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    try {
      await assertUserNotAppBlocked({
        id: String(profile.id || ""),
        email: String(profile.email || "").toLowerCase(),
        role: String(profile.role || "")
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(403).send({ ok: false, error: msg });
    }

    const { equipment_item_id, start_at, end_at, note } = parsed.data;
    const s = new Date(start_at).getTime();
    const e = new Date(end_at).getTime();
    if (e <= s) return reply.code(400).send({ ok: false, error: "end_at must be after start_at." });
    if (hasPublicHolidayInRange(start_at, end_at)) {
      return reply.code(409).send({ ok: false, error: "Reservations are closed on official public holidays." });
    }
    try {
      await assertDepotSlotCapacity({ startAt: start_at, endAt: end_at });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(409).send({ ok: false, error: msg });
    }

    const { data: item, error: itemErr } = await supabaseAdmin
      .from("equipment_items")
      .select("*")
      .eq("id", equipment_item_id)
      .limit(1)
      .maybeSingle();
    if (itemErr) return reply.code(500).send({ ok: false, error: itemErr.message });
    if (!item) return reply.code(404).send({ ok: false, error: "Equipment not found." });
    if (String(item.status || "").toUpperCase() !== "AVAILABLE") {
      return reply.code(409).send({ ok: false, error: "Equipment not available." });
    }
    const requiredLevel = parseEquipmentLevel((item as Record<string, unknown>).required_level);
    const canUseLevel5 = canOperateLevel5Equipment(profile as Record<string, unknown>);
    if (requiredLevel >= 5 && !canUseLevel5) {
      return reply.code(403).send({ ok: false, error: "Bu ekipman yalnızca super_admin, technician veya senior kullanıcılar için erişilebilir." });
    }
    const matrix = resolveAccessMatrix(profile as Record<string, unknown>);
    if (requiredLevel > matrix.maxEquipmentLevel) {
      return reply
        .code(403)
        .send({ ok: false, error: `Bu ekipman seviye ${requiredLevel} yetkisi gerektirir. Hesabinizin azami seviyesi ${matrix.maxEquipmentLevel}.` });
    }

    if (!isAppAdminRole(String(profile.role || ""))) {
      const targetCategory = resolveEquipmentCategoryBucket(item as Record<string, unknown>);
      const maxInCategory = EQUIPMENT_CATEGORY_LIMITS[targetCategory] ?? EQUIPMENT_CATEGORY_DEFAULT_LIMIT;
      const profileId = String(profile.id || "").trim();
      const requesterEmail = String(profile.email || "").trim().toLowerCase();
      if (profileId || requesterEmail) {
        const ownerFilter = profileId && requesterEmail
          ? `requester_profile_id.eq.${profileId},requester_email.eq.${requesterEmail}`
          : profileId
            ? `requester_profile_id.eq.${profileId}`
            : `requester_email.eq.${requesterEmail}`;
        const loansRes = await supabaseAdmin
          .from("equipment_reservations")
          .select("equipment_item_id")
          .or(ownerFilter)
          .in("status", EQUIPMENT_ON_LOAN_RES_STATUSES);
        if (loansRes.error) return reply.code(500).send({ ok: false, error: loansRes.error.message });

        const loanItemIds = Array.from(
          new Set(
            (loansRes.data ?? [])
              .map((r) => String((r as Record<string, unknown>).equipment_item_id || "").trim())
              .filter(Boolean)
          )
        );
        if (loanItemIds.length) {
          const loanItemsRes = await supabaseAdmin
            .from("equipment_items")
            .select("id,name,category,type,type_desc,equipment_id")
            .in("id", loanItemIds);
          if (loanItemsRes.error) return reply.code(500).send({ ok: false, error: loanItemsRes.error.message });
          let sameCategoryOnLoan = 0;
          for (const li of (loanItemsRes.data ?? []) as Record<string, unknown>[]) {
            if (resolveEquipmentCategoryBucket(li) === targetCategory) sameCategoryOnLoan += 1;
          }
          if (sameCategoryOnLoan >= maxInCategory) {
            return reply.code(409).send({
              ok: false,
              error:
                `Bu kategoride limit dolu (${targetCategory}: ${sameCategoryOnLoan}/${maxInCategory}). ` +
                "Üzerinizdeki ekipmanı iade etmeden bu kategoriden yeni rezervasyon açamazsınız."
            });
          }
        }

        const modelCapRaw = Number((item as Record<string, unknown>).eq_max_per_reservation);
        const modelCap = Number.isFinite(modelCapRaw) && modelCapRaw >= 1 ? Math.floor(modelCapRaw) : null;
        if (modelCap != null) {
          const activeRes = await supabaseAdmin
            .from("equipment_reservations")
            .select("equipment_item_id")
            .or(ownerFilter)
            .in("status", EQUIPMENT_ACTIVE_RES_STATUSES);
          if (activeRes.error) return reply.code(500).send({ ok: false, error: activeRes.error.message });

          const activeItemIds = Array.from(
            new Set(
              (activeRes.data ?? [])
                .map((r) => String((r as Record<string, unknown>).equipment_item_id || "").trim())
                .filter(Boolean)
            )
          );
          if (activeItemIds.length) {
            const activeItemsRes = await supabaseAdmin
              .from("equipment_items")
              .select("id,name")
              .in("id", activeItemIds);
            if (activeItemsRes.error) return reply.code(500).send({ ok: false, error: activeItemsRes.error.message });

            const targetModelName = normalizeModelNameKey(
              (item as Record<string, unknown>).name || (item as Record<string, unknown>).equipment_name || (item as Record<string, unknown>).id
            );
            let sameModelActiveCount = 0;
            for (const ai of (activeItemsRes.data ?? []) as Record<string, unknown>[]) {
              if (normalizeModelNameKey(ai.name) === targetModelName) sameModelActiveCount += 1;
            }
            if (sameModelActiveCount >= modelCap) {
              return reply.code(409).send({
                ok: false,
                error: `Bu model için limit dolu (${sameModelActiveCount}/${modelCap}). Aynı modelden daha fazla rezervasyon yapamazsınız.`
              });
            }
          }
        }
      }
    }

    const overlap = await supabaseAdmin
      .from("equipment_reservations")
      .select("id,status,requester_profile_id,requester_email,start_at,end_at")
      .eq("equipment_item_id", equipment_item_id)
      .in("status", ["pending", "approved", EQUIPMENT_CHECKED_OUT_STATUS, "checked_out"])
      .lt("start_at", end_at)
      .gt("end_at", start_at)
      .limit(1);
    if (overlap.error) return reply.code(500).send({ ok: false, error: overlap.error.message });
    if ((overlap.data ?? []).length > 0) {
      const existing = overlap.data?.[0] as
        | {
            id?: string;
            status?: string;
            requester_profile_id?: string;
            requester_email?: string;
            start_at?: string;
            end_at?: string;
          }
        | undefined;
      const sameUserById = String(existing?.requester_profile_id || "") === String(profile.id || "");
      const sameUserByEmail =
        String(existing?.requester_email || "").toLowerCase() === String(profile.email || "").toLowerCase();
      if (sameUserById || sameUserByEmail) {
        return {
          ok: true,
          duplicate: true,
          data: {
            id: String(existing?.id || ""),
            status: String(existing?.status || "pending"),
            equipment_item_id,
            start_at: String(existing?.start_at || start_at),
            end_at: String(existing?.end_at || end_at)
          }
        };
      }
      return reply.code(409).send({ ok: false, error: "Equipment has conflicting reservation." });
    }

    const payload = {
      equipment_item_id,
      requester_profile_id: profile.id,
      requester_email: profile.email,
      requester_name: profile.full_name || profile.email,
      required_level: Number(item.required_level || 1),
      status: isAdminRole(profile.role) ? "approved" : "pending",
      approval_required: !isAdminRole(profile.role),
      start_at,
      end_at,
      note
    };

    const { data, error } = await supabaseAdmin
      .from("equipment_reservations")
      .insert(payload)
      .select("*")
      .single();
    if (error) return reply.code(500).send({ ok: false, error: error.message });
    return { ok: true, data };
  });

  app.post("/admin/studio-reservations/approve", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const actor = getAuthProfile(req);
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });

    const { id, note } = parsed.data;
    const { data, error } = await supabaseAdmin
      .from("studio_reservations")
      .update({
        status: STUDIO_APPROVED_STATUS,
        reviewed_by: actor.email,
        reviewed_at: new Date().toISOString(),
        purpose: note ?? undefined
      })
      .eq("id", id)
      .select("*")
      .single();
    if (error) return reply.code(500).send({ ok: false, error: error.message });
    return { ok: true, data };
  });

  app.post("/admin/studio-reservations/reject", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const actor = getAuthProfile(req);
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });

    const { id, note } = parsed.data;
    const { data, error } = await supabaseAdmin
      .from("studio_reservations")
      .update({
        status: STUDIO_REJECTED_STATUS,
        reviewed_by: actor.email,
        reviewed_at: new Date().toISOString(),
        purpose: note ?? undefined
      })
      .eq("id", id)
      .select("*")
      .single();
    if (error) return reply.code(500).send({ ok: false, error: error.message });
    return { ok: true, data };
  });

  app.post("/admin/equipment-reservations/approve", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const actor = getAuthProfile(req);
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });

    const { id, note } = parsed.data;
    const { data, error } = await supabaseAdmin
      .from("equipment_reservations")
      .update({
        status: "approved",
        reviewed_by: actor.email,
        reviewed_at: new Date().toISOString(),
        note: note ?? undefined
      })
      .eq("id", id)
      .select("*")
      .single();
    if (error) return reply.code(500).send({ ok: false, error: error.message });
    return { ok: true, data };
  });

  app.post("/admin/equipment-reservations/reject", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const actor = getAuthProfile(req);
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });

    const { id, note } = parsed.data;
    const { data, error } = await supabaseAdmin
      .from("equipment_reservations")
      .update({
        status: "rejected",
        reviewed_by: actor.email,
        reviewed_at: new Date().toISOString(),
        note: note ?? undefined
      })
      .eq("id", id)
      .select("*")
      .single();
    if (error) return reply.code(500).send({ ok: false, error: error.message });
    return { ok: true, data };
  });

  app.post("/admin/traffic/checkout", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const actor = getAuthProfile(req);
    const actorRecord = actor as unknown as Record<string, unknown>;
    const canUseLevel5 = canOperateLevel5Equipment(actorRecord);
    const parsed = adminTrafficActionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const id = String(parsed.data.id || "").trim();
    const selectedItemIds = dedupeTrimmedIds(parsed.data.item_ids);
    const checkoutConditionMap = parsed.data.checkout_condition_map || {};
    const studioHandoverNote = String(parsed.data.studio_handover_note || "").trim();
    const nowIso = new Date().toISOString();

    const eqLookup = await supabaseAdmin
      .from("equipment_reservations")
      .select("id,equipment_item_id,status,start_at,end_at,requester_name,requester_email,requester_profile_id,required_level,note")
      .eq("id", id)
      .maybeSingle();
    if (eqLookup.error) return reply.code(500).send({ ok: false, error: eqLookup.error.message });
    if (eqLookup.data) {
      const eqRes = eqLookup.data as Record<string, unknown>;
      const eqId = String(eqRes.equipment_item_id || "").trim();
      const allItemIds = dedupeTrimmedIds([eqId, ...selectedItemIds]);
      if (!allItemIds.length) return reply.code(400).send({ ok: false, error: "No equipment item selected for checkout." });

      const reservationStartAt = String(eqRes.start_at || "");
      const reservationEndAt = String(eqRes.end_at || "");
      const requesterProfileId = eqRes.requester_profile_id ? String(eqRes.requester_profile_id) : null;
      const requiredLevelRaw = Number(eqRes.required_level);
      const requiredLevel = Number.isFinite(requiredLevelRaw) ? requiredLevelRaw : 1;
      const reservationNote = String(eqRes.note || "");
      const requesterEmail = String(eqRes.requester_email || "").toLowerCase();
      const requesterName = String(eqRes.requester_name || "");

      const itemMetaRes = await supabaseAdmin
        .from("equipment_items")
        .select("id,name,equipment_id,condition_out,required_level")
        .in("id", allItemIds);
      if (itemMetaRes.error) return reply.code(500).send({ ok: false, error: itemMetaRes.error.message });
      const itemMetaById = new Map(
        ((itemMetaRes.data ?? []) as Record<string, unknown>[]).map((r) => [String(r.id || "").trim(), r])
      );

      for (const itemId of selectedItemIds) {
        if (!itemId || itemId === eqId) continue;
        const itemRow = itemMetaById.get(itemId);
        if (!itemRow) continue;
        const requiredLevel = parseEquipmentLevel(itemRow.required_level);
        if (requiredLevel >= 5 && !canUseLevel5) {
          return reply.code(403).send({ ok: false, error: "Seviye 5 ekipman yalnızca super_admin, technician veya senior kullanıcılar için checkout'a eklenebilir." });
        }
      }

      const itemsForPdf: Array<{ name: string; code: string; conditionOut: string }> = [];
      for (const itemId of allItemIds) {
        const itemRow = itemMetaById.get(itemId);
        if (!itemRow) return reply.code(404).send({ ok: false, error: `Equipment item not found: ${itemId}` });
        const mappedCond = findMappedConditionOut(checkoutConditionMap, itemId);
        itemsForPdf.push({
          name: String(itemRow.name || ""),
          code: String(itemRow.equipment_id || itemId),
          conditionOut: String(mappedCond || itemRow.condition_out || "")
        });
      }

      let pdfUrl: string | null = null;
      try {
        pdfUrl = await generateCheckoutPdf({
          kind: "equipment",
          reservationId: String(eqRes.id || id),
          studentName: requesterName,
          studentEmail: requesterEmail,
          startAt: reservationStartAt,
          endAt: reservationEndAt,
          projectExplanation: reservationNote,
          items: itemsForPdf
        });
      } catch (e) {
        req.log.error({ err: e }, "generate equipment checkout pdf failed");
        const msg = e instanceof Error ? e.message : String(e);
        return reply.code(500).send({ ok: false, error: "PDF_GENERATION_FAILED: " + msg });
      }

      const eqMark = await updateEquipmentReservationToCheckedOut(id, {
        reviewed_by: actor.email,
        reviewed_at: nowIso
      });
      if (eqMark.error) return reply.code(500).send({ ok: false, error: eqMark.error.message });
      const checkoutStatusUsed = eqMark.status || EQUIPMENT_CHECKED_OUT_STATUS;
      if (checkoutStatusUsed !== EQUIPMENT_CHECKED_OUT_STATUS) {
        req.log.warn(
          { reservationId: id, preferredStatus: EQUIPMENT_CHECKED_OUT_STATUS, fallbackStatus: checkoutStatusUsed },
          "equipment checkout status fallback applied for equipment_reservations"
        );
      }

      for (const itemId of allItemIds) {
        const patch: Record<string, unknown> = { status: "IN_USE" };
        const condOut = findMappedConditionOut(checkoutConditionMap, itemId);
        if (condOut) patch.condition_out = condOut;
        const updItem = await supabaseAdmin
          .from("equipment_items")
          .update(patch)
          .eq("id", itemId)
          .select("id")
          .maybeSingle();
        if (updItem.error) return reply.code(500).send({ ok: false, error: updItem.error.message });
        if (!updItem.data) return reply.code(404).send({ ok: false, error: `Equipment item not found: ${itemId}` });

        if (itemId !== eqId) {
          const existingExtra = await supabaseAdmin
            .from("equipment_reservations")
            .select("id,status")
            .eq("equipment_item_id", itemId)
            .eq("requester_email", requesterEmail)
            .eq("start_at", reservationStartAt)
            .eq("end_at", reservationEndAt)
            .in("status", EQUIPMENT_ACTIVE_RES_STATUSES)
            .limit(1);
          if (existingExtra.error) return reply.code(500).send({ ok: false, error: existingExtra.error.message });

          if ((existingExtra.data ?? []).length === 0) {
            const createdExtra = await insertEquipmentReservationAsCheckedOut({
              equipment_item_id: itemId,
              requester_profile_id: requesterProfileId,
              requester_email: requesterEmail,
              requester_name: requesterName,
              required_level: requiredLevel,
              approval_required: false,
              start_at: reservationStartAt,
              end_at: reservationEndAt,
              note: reservationNote,
              reviewed_by: String(actor.email || ""),
              reviewed_at: nowIso
            });
            if (createdExtra.error) return reply.code(500).send({ ok: false, error: createdExtra.error.message });
          } else {
            const existingId = String((existingExtra.data?.[0] as Record<string, unknown> | undefined)?.id || "").trim();
            if (existingId) {
              const updExisting = await updateEquipmentReservationToCheckedOut(existingId, {
                reviewed_by: String(actor.email || ""),
                reviewed_at: nowIso
              });
              if (updExisting.error) return reply.code(500).send({ ok: false, error: updExisting.error.message });
            }
          }
        }
      }

      if (pdfUrl && requesterEmail && requesterEmail.includes("@")) {
        try {
          await sendCheckoutPdfAttachmentEmail(requesterEmail, {
            kind: "equipment",
            reservationId: String(eqRes.id || id),
            studentName: requesterName,
            startAt: reservationStartAt,
            endAt: reservationEndAt,
            pdfDataUrl: pdfUrl
          });
        } catch (e) {
          req.log.error({ err: e, reservationId: String(eqRes.id || id), requesterEmail }, "send equipment checkout pdf mail failed");
        }
      }
      return { ok: true, success: true, id, status: checkoutStatusUsed, url: pdfUrl || "" };
    }

    const stLookup = await supabaseAdmin
      .from("studio_reservations")
      .select("id,status,studio_id,start_at,end_at,requester_name,requester_email,purpose")
      .eq("id", id)
      .maybeSingle();
    if (stLookup.error) return reply.code(500).send({ ok: false, error: stLookup.error.message });
    if (stLookup.data) {
      const stRow = stLookup.data as Record<string, unknown>;
      const studioId = String(stRow.studio_id || "").trim();
      let studioName = studioId;
      if (studioId) {
        const stMeta = await supabaseAdmin.from("studios").select("id,name").eq("id", studioId).limit(1).maybeSingle();
        if (stMeta.error) {
          req.log.error({ err: stMeta.error, studioId }, "resolve studio name failed on checkout");
        } else if (stMeta.data) {
          studioName = String((stMeta.data as Record<string, unknown>).name || studioId);
        }
      }
      try {
        const pdfUrl = await generateCheckoutPdf({
          kind: "studio",
          reservationId: String(stRow.id || id),
          studentName: String(stRow.requester_name || ""),
          studentEmail: String(stRow.requester_email || ""),
          startAt: String(stRow.start_at || ""),
          endAt: String(stRow.end_at || ""),
          studioName: String(studioName || studioId || "Studio"),
          projectName: String(stRow.purpose || ""),
          handoverNote: studioHandoverNote
        });
        const requesterEmail = String(stRow.requester_email || "").trim().toLowerCase();
        let stMark = await supabaseAdmin
          .from("studio_reservations")
          .update({
            status: STUDIO_PICKED_STATUS,
            studio_handover_note: studioHandoverNote || null,
            reviewed_by: actor.email,
            reviewed_at: nowIso
          })
          .eq("id", id)
          .select("id,status")
          .single();
        if (stMark.error && isMissingColumnError(stMark.error)) {
          req.log.warn({ err: stMark.error }, "studio_handover_note column missing, retrying checkout update without note");
          stMark = await supabaseAdmin
            .from("studio_reservations")
            .update({
              status: STUDIO_PICKED_STATUS,
              reviewed_by: actor.email,
              reviewed_at: nowIso
            })
            .eq("id", id)
            .select("id,status")
            .single();
        }
        if (stMark.error) return reply.code(500).send({ ok: false, error: stMark.error.message });
        if (pdfUrl && requesterEmail && requesterEmail.includes("@")) {
          try {
            await sendCheckoutPdfAttachmentEmail(requesterEmail, {
              kind: "studio",
              reservationId: String(stRow.id || id),
              studentName: String(stRow.requester_name || ""),
              startAt: String(stRow.start_at || ""),
              endAt: String(stRow.end_at || ""),
              studioName: String(studioName || studioId || "Studio"),
              pdfDataUrl: pdfUrl
            });
          } catch (e) {
            req.log.error({ err: e, reservationId: String(stRow.id || id), requesterEmail }, "send studio checkout pdf mail failed");
          }
        }
        return {
          ok: true,
          success: true,
          id,
          status: String((stMark.data as Record<string, unknown> | null)?.status || STUDIO_PICKED_STATUS),
          url: pdfUrl || ""
        };
      } catch (e) {
        req.log.error({ err: e }, "generate studio checkout pdf failed");
        const msg = e instanceof Error ? e.message : String(e);
        return reply.code(500).send({ ok: false, error: "PDF_GENERATION_FAILED: " + msg });
      }
    }

    return reply.code(404).send({ ok: false, error: "Reservation not found." });
  });

  app.post("/admin/traffic/checkin", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const actor = getAuthProfile(req);
    const parsed = adminTrafficActionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const id = String(parsed.data.id || "").trim();
    const nowIso = new Date().toISOString();

    const eqBefore = await supabaseAdmin
      .from("equipment_reservations")
      .select("id,equipment_item_id,status,end_at,requester_profile_id,requester_name,requester_email")
      .eq("id", id)
      .maybeSingle();
    if (eqBefore.error) return reply.code(500).send({ ok: false, error: eqBefore.error.message });
    if (eqBefore.data) {
      const before = eqBefore.data as Record<string, unknown>;
      const currentStatus = String(before.status || "").toLowerCase();
      if (!EQUIPMENT_ON_LOAN_RES_STATUSES.includes(currentStatus)) {
        return reply.code(400).send({ ok: false, error: `Checkin is only allowed for on-loan items. Current status: ${currentStatus || "unknown"}` });
      }

      const eq = await supabaseAdmin
        .from("equipment_reservations")
        .update({
          status: "returned",
          reviewed_by: actor.email,
          reviewed_at: nowIso
        })
        .eq("id", id)
        .select("id,equipment_item_id,status")
        .single();
      if (eq.error) return reply.code(500).send({ ok: false, error: eq.error.message });

      const eqId = String((eq.data as Record<string, unknown>).equipment_item_id || "").trim();
      let notify: { table: string | null; matched: number; sent: number; failed: number; keys: string[] } | null = null;
      if (eqId) {
        const updItem = await supabaseAdmin
          .from("equipment_items")
          .update({ status: "AVAILABLE" })
          .eq("id", eqId)
          .select("id,equipment_id,name")
          .maybeSingle();
        if (updItem.error) return reply.code(500).send({ ok: false, error: updItem.error.message });
        if (updItem.data) {
          try {
            notify = await triggerNotifyForAvailableEquipment(updItem.data, req.log);
          } catch (e) {
            req.log.error({ err: e, equipmentItemId: eqId }, "trigger available notify failed (checkin)");
          }
        }
      }

      let penalty: { action: string; is_ban: boolean; reason: string; expires_at: string; level?: string } | null = null;
      try {
        penalty = await applyLateReturnPenalty({
          reservationId: String(before.id || id),
          itemId: eqId,
          itemName: "",
          userId: String(before.requester_profile_id || ""),
          userName: String(before.requester_name || before.requester_email || ""),
          userEmail: String(before.requester_email || "").toLowerCase(),
          dueAt: String(before.end_at || ""),
          returnAt: nowIso,
          actorId: String(actor.id || actor.email || "SYSTEM")
        });
      } catch (e) {
        req.log.error({ err: e, reservationId: id }, "late return penalty application failed");
      }

      return { ok: true, success: true, id, status: "returned", penalty, notify };
    }

    let st = await supabaseAdmin
      .from("studio_reservations")
      .update({
        status: STUDIO_RETURNED_STATUS,
        return_handover_note: String(parsed.data.studio_handover_note || "").trim() || null,
        reviewed_by: actor.email,
        reviewed_at: nowIso
      })
      .eq("id", id)
      .select("id,status")
      .maybeSingle();
    if (st.error && isMissingColumnError(st.error)) {
      req.log.warn({ err: st.error }, "return_handover_note column missing, retrying checkin update without note");
      st = await supabaseAdmin
        .from("studio_reservations")
        .update({
          status: STUDIO_RETURNED_STATUS,
          reviewed_by: actor.email,
          reviewed_at: nowIso
        })
        .eq("id", id)
        .select("id,status")
        .maybeSingle();
    }
    if (st.error) return reply.code(500).send({ ok: false, error: st.error.message });
    if (st.data) return { ok: true, success: true, id, status: String((st.data as Record<string, unknown>).status || STUDIO_RETURNED_STATUS) };

    return reply.code(404).send({ ok: false, error: "Reservation not found." });
  });

  app.get("/admin/overdue-equipment", { preHandler: requireRoles(ADMIN_ROLES) }, async (_req, reply) => {
    try {
      const list = await listOverdueEquipmentRows();
      return { ok: true, list };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ ok: false, error: msg, list: [] });
    }
  });

  app.post("/admin/overdue-reminders", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const parsed = adminOverdueReminderSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten(), success: false });
    const ids = Array.from(new Set((parsed.data.equipment_ids || []).map((x) => String(x || "").trim()).filter(Boolean)));
    if (!ids.length) return { ok: true, success: false, error: "No equipment selected.", sent: 0, skipped: 0 };

    try {
      const list = await listOverdueEquipmentRows();
      const byId = new Map(list.map((r) => [String(r.id || "").trim(), r]));
      let sent = 0;
      let skipped = 0;
      for (const id of ids) {
        const row = byId.get(id);
        if (!row) {
          skipped += 1;
          continue;
        }
        const email = String(row.userEmail || row.emailHint || "").trim().toLowerCase();
        if (!email || !email.includes("@")) {
          skipped += 1;
          continue;
        }
        try {
          await sendOverdueReminderEmail(email, { name: row.name, id: row.id, due: row.due });
          sent += 1;
        } catch (e) {
          req.log.error({ err: e, equipmentId: row.id, email }, "send overdue reminder failed");
          skipped += 1;
        }
      }
      return { ok: true, success: true, sent, skipped };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ ok: false, success: false, error: msg, sent: 0, skipped: ids.length });
    }
  });

  app.get("/admin/penalties", { preHandler: requireRoles(ADMIN_ROLES) }, async (_req, reply) => {
    try {
      const list = await listAdminPenalties();
      return { ok: true, list };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ ok: false, error: msg, list: [] });
    }
  });

  app.post("/admin/traffic/cancel", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const actor = getAuthProfile(req);
    const parsed = adminTrafficActionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const id = String(parsed.data.id || "").trim();

    const eq = await supabaseAdmin
      .from("equipment_reservations")
      .update({
        status: "cancelled",
        reviewed_by: actor.email,
        reviewed_at: new Date().toISOString()
      })
      .eq("id", id)
      .select("id,equipment_item_id")
      .maybeSingle();
    if (eq.error) return reply.code(500).send({ ok: false, error: eq.error.message });
    if (eq.data) {
      const eqId = String((eq.data as Record<string, unknown>).equipment_item_id || "").trim();
      let notify: { table: string | null; matched: number; sent: number; failed: number; keys: string[] } | null = null;
      if (eqId) {
        const updItem = await supabaseAdmin
          .from("equipment_items")
          .update({ status: "AVAILABLE" })
          .eq("id", eqId)
          .select("id,equipment_id,name")
          .maybeSingle();
        if (updItem.error) return reply.code(500).send({ ok: false, error: updItem.error.message });
        if (updItem.data) {
          try {
            notify = await triggerNotifyForAvailableEquipment(updItem.data, req.log);
          } catch (e) {
            req.log.error({ err: e, equipmentItemId: eqId }, "trigger available notify failed (cancel)");
          }
        }
      }
      return { ok: true, success: true, id, status: "cancelled", notify };
    }

    const st = await supabaseAdmin
      .from("studio_reservations")
      .update({
        status: STUDIO_CANCELLED_STATUS,
        reviewed_by: actor.email,
        reviewed_at: new Date().toISOString()
      })
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (st.error) return reply.code(500).send({ ok: false, error: st.error.message });
    if (st.data) return { ok: true, success: true, id, status: STUDIO_CANCELLED_STATUS };
    return reply.code(404).send({ ok: false, error: "Reservation not found." });
  });

  app.post("/admin/traffic/extend", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const parsed = adminTrafficExtendSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const id = String(parsed.data.id || "").trim();
    const newEndAt = String(parsed.data.new_end_at || "");

    const eqBefore = await supabaseAdmin
      .from("equipment_reservations")
      .select("id,start_at,end_at")
      .eq("id", id)
      .maybeSingle();
    if (eqBefore.error) return reply.code(500).send({ ok: false, error: eqBefore.error.message });
    if (eqBefore.data) {
      const startAt = String((eqBefore.data as Record<string, unknown>).start_at || "");
      const startMs = new Date(startAt).getTime();
      const endMs = new Date(newEndAt).getTime();
      if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
        return reply.code(400).send({ ok: false, error: "Invalid extension range." });
      }
      try {
        await assertDepotSlotCapacity({
          startAt,
          endAt: newEndAt,
          excludeReservationId: id,
          checkStart: false,
          checkEnd: true
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return reply.code(409).send({ ok: false, error: msg });
      }
      const eq = await supabaseAdmin
        .from("equipment_reservations")
        .update({ end_at: newEndAt })
        .eq("id", id)
        .select("id,end_at")
        .single();
      if (eq.error) return reply.code(500).send({ ok: false, error: eq.error.message });
      return { ok: true, success: true, id, end_at: newEndAt };
    }

    const st = await supabaseAdmin
      .from("studio_reservations")
      .update({ end_at: newEndAt })
      .eq("id", id)
      .select("id,end_at")
      .maybeSingle();
    if (st.error) return reply.code(500).send({ ok: false, error: st.error.message });
    if (st.data) return { ok: true, success: true, id, end_at: newEndAt };

    return reply.code(404).send({ ok: false, error: "Reservation not found." });
  });

  app.post("/admin/traffic/transfer", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const parsed = adminTrafficTransferSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const id = String(parsed.data.id || "").trim();
    const raw = String(parsed.data.query || "").trim();
    const user = await lookupProfileByAdminQuery(raw);
    if (user.error) return reply.code(500).send({ ok: false, error: user.error.message });
    if (!user.data) return reply.code(404).send({ ok: false, error: "Target user not found." });
    const p = user.data as Record<string, unknown>;
    const payload = {
      requester_profile_id: String(p.id || ""),
      requester_email: String(p.email || "").toLowerCase(),
      requester_name: String(p.full_name || p.email || "")
    };
    const targetCanUseLevel5 = canOperateLevel5Equipment(p);

    const eqExisting = await supabaseAdmin
      .from("equipment_reservations")
      .select("id,required_level")
      .eq("id", id)
      .maybeSingle();
    if (eqExisting.error) return reply.code(500).send({ ok: false, error: eqExisting.error.message });
    if (eqExisting.data) {
      const requiredLevel = parseEquipmentLevel((eqExisting.data as Record<string, unknown>).required_level);
      if (requiredLevel >= 5 && !targetCanUseLevel5) {
        return reply.code(403).send({ ok: false, error: "Seviye 5 ekipman rezervasyonu yalnızca super_admin, technician veya senior kullanıcıya devredilebilir." });
      }
    }

    const eq = await supabaseAdmin
      .from("equipment_reservations")
      .update(payload)
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (eq.error) return reply.code(500).send({ ok: false, error: eq.error.message });
    if (eq.data) return { ok: true, success: true, id };

    const st = await supabaseAdmin
      .from("studio_reservations")
      .update(payload)
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (st.error) return reply.code(500).send({ ok: false, error: st.error.message });
    if (st.data) return { ok: true, success: true, id };

    return reply.code(404).send({ ok: false, error: "Reservation not found." });
  });

  app.post("/admin/equipment/lookup", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const parsed = adminEquipmentLookupSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const raw = String(parsed.data.query || "").trim();
    const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw);
    let result:
      | { data: Record<string, unknown> | null; error: { message: string } | null }
      | { data: null; error: null } = { data: null, error: null };

    if (uuidLike) {
      result = await supabaseAdmin.from("equipment_items").select("*").eq("id", raw).limit(1).maybeSingle();
      if (result.error) return reply.code(500).send({ ok: false, error: result.error.message });
    }
    if (!result.data) {
      result = await supabaseAdmin
        .from("equipment_items")
        .select("*")
        .eq("equipment_id", raw.toUpperCase())
        .limit(1)
        .maybeSingle();
      if (result.error) return reply.code(500).send({ ok: false, error: result.error.message });
    }
    if (!result.data) {
      result = await supabaseAdmin.from("equipment_items").select("*").ilike("name", `%${raw}%`).limit(1).maybeSingle();
      if (result.error) return reply.code(500).send({ ok: false, error: result.error.message });
    }
    if (!result.data) return reply.code(404).send({ ok: false, error: "Equipment not found." });
    const row = result.data as Record<string, unknown>;
    return {
      ok: true,
      item: {
        eqId: String(row.id || ""),
        name: String(row.name || row.id || ""),
        eqType: String(row.category || row.type || ""),
        status: String(row.status || "")
      }
    };
  });

  app.post("/equipment-notify/subscribe", { preHandler: requireAuth }, async (req, reply) => {
    const profile = getAuthProfile(req);
    const parsed = notifySubscribeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const { group_key, label } = parsed.data;
    const email = String(profile.email || "").trim().toLowerCase();
    for (const table of NOTIFY_TABLE_CANDIDATES) {
      const existing = await supabaseAdmin
        .from(table)
        .select("id")
        .eq("email", email)
        .eq("group_key", group_key)
        .is("notified_at", null)
        .limit(1);
      if (existing.error) {
        if (isMissingTableError(existing.error)) continue;
        return reply.code(500).send({ ok: false, error: existing.error.message });
      }
      if ((existing.data ?? []).length > 0) return { ok: true, duplicate: true };

      const payload =
        table === "equipment_notify_subscriptions"
          ? {
              id: "NTF-" + Math.floor(100000 + Math.random() * 900000),
              email,
              group_key,
              label,
              notified_at: null
            }
          : { email, group_key, label, notified_at: null };
      const created = await supabaseAdmin.from(table).insert(payload).select("id").single();
      if (created.error) {
        if (isMissingTableError(created.error)) continue;
        return reply.code(500).send({ ok: false, error: created.error.message });
      }
      return { ok: true, duplicate: false, id: String(created.data?.id || "") };
    }
    return reply.code(501).send({ ok: false, error: "Notify table is not configured in Supabase." });
  });

  app.post("/contact/messages", { preHandler: requireAuth }, async (req, reply) => {
    const profile = getAuthProfile(req);
    const parsed = contactMessageSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const ref = String(parsed.data.reservation_ref || "").trim();

    const [eq, st] = await Promise.all([
      supabaseAdmin.from("equipment_reservations").select("id,status,requester_profile_id,requester_email").eq("id", ref).limit(1),
      supabaseAdmin.from("studio_reservations").select("id,status,requester_profile_id,requester_email").eq("id", ref).limit(1)
    ]);
    if (eq.error) return reply.code(500).send({ ok: false, error: eq.error.message });
    if (st.error) return reply.code(500).send({ ok: false, error: st.error.message });

    const row = (eq.data ?? [])[0] || (st.data ?? [])[0] || null;
    if (!row) return reply.code(404).send({ ok: false, error: "Reservation not found." });

    const ownerById = String(row.requester_profile_id || "") === String(profile.id || "");
    const ownerByEmail = String(row.requester_email || "").toLowerCase() === String(profile.email || "").toLowerCase();
    if (!ownerById && !ownerByEmail) return reply.code(403).send({ ok: false, error: "Reservation does not belong to current user." });
    if (!reservationIsActive(String(row.status || ""))) {
      return reply.code(400).send({ ok: false, error: "Selected reservation is not active." });
    }

    const candidates = ["contact_messages", "contact_requests", "support_messages", "bize_contact"];
    for (const table of candidates) {
      const insertPayload =
        table === "bize_contact"
          ? {
              id: "BZ-" + Math.floor(100000 + Math.random() * 900000),
              created_at: new Date().toISOString(),
              user_id: profile.id,
              user_name: profile.full_name || profile.email,
              user_email: profile.email,
              reservation_ref: ref,
              message: parsed.data.message,
              status: "Yeni",
              admin_reply: "",
              updated_at: new Date().toISOString()
            }
          : {
              reservation_ref: ref,
              requester_profile_id: profile.id,
              requester_email: profile.email,
              requester_name: profile.full_name || profile.email,
              message: parsed.data.message,
              status: "new"
            };
      const created = await supabaseAdmin
        .from(table)
        .insert(insertPayload)
        .select("id")
        .single();
      if (!created.error) return { ok: true, id: String(created.data?.id || "") };
      if (!isMissingTableError(created.error)) return reply.code(500).send({ ok: false, error: created.error.message });
    }
    return reply.code(501).send({ ok: false, error: "Contact table is not configured in Supabase." });
  });

  app.post("/tickets", { preHandler: requireAuth }, async (req, reply) => {
    const profile = getAuthProfile(req);
    if (String(profile.role || "").toLowerCase() === "student") {
      return reply.code(403).send({ ok: false, error: "This form is only available to staff." });
    }
    const parsed = ticketCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const ticketNo = "TCK-" + Math.floor(100000 + Math.random() * 900000);
    const payload = parsed.data;
    const candidates = ["tickets", "support_tickets"];
    for (const table of candidates) {
      const insertPayload =
        table === "tickets"
          ? {
              ticket_no: ticketNo,
              created_at: new Date().toISOString(),
              name: profile.full_name || profile.email,
              email: profile.email,
              phone_ext: payload.phone || "",
              department: profile.department_name || profile.faculty_name || "",
              staff_type: profile.staff_type || "",
              request_type: "Çekim",
              use_date: payload.start_at,
              description: payload.description,
              status: "Beklemede / Pending",
              ticket_type: payload.ticket_type,
              start_dt: payload.start_at,
              end_dt: payload.end_at,
              location: payload.location || ""
            }
          : {
              ticket_no: ticketNo,
              requester_profile_id: profile.id,
              requester_email: profile.email,
              requester_name: profile.full_name || profile.email,
              department: profile.department_name || profile.faculty_name || "",
              staff_type: profile.staff_type || "",
              ticket_type: payload.ticket_type,
              request_type: "Çekim",
              start_dt: payload.start_at,
              end_dt: payload.end_at,
              use_date: payload.start_at,
              location: payload.location || "",
              description: payload.description,
              phone_ext: payload.phone || "",
              status: "Beklemede / Pending"
            };
      const created = await supabaseAdmin
        .from(table)
        .insert(insertPayload)
        .select(table === "tickets" ? "ticket_no" : "id,ticket_no")
        .single();
      if (!created.error) return { ok: true, ticket_no: String((created.data as { ticket_no?: string } | null)?.ticket_no || ticketNo) };
      if (!isMissingTableError(created.error)) return reply.code(500).send({ ok: false, error: created.error.message });
    }
    return reply.code(501).send({ ok: false, error: "Tickets table is not configured in Supabase." });
  });

  app.post("/admin/lookup-user", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const parsed = quickLookupSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const raw = String(parsed.data.query || "").trim();
    const isEmail = raw.includes("@");
    const result = await lookupProfileByAdminQuery(raw);
    if (result.error) return reply.code(500).send({ ok: false, error: result.error.message });
    const p = result.data;
    if (!p) {
      return {
        ok: true,
        name: "",
        email: isEmail ? raw.toLowerCase() : "",
        studentId: isEmail ? raw.toLowerCase() : raw,
        note: "not_found"
      };
    }
    return {
      ok: true,
      name: String(p.full_name || ""),
      email: String(p.email || ""),
      studentId: String(p.student_number || p.staff_auto_id || p.staff_number || p.id || ""),
      level: String(resolveAccessMatrix(p as Record<string, unknown>).maxEquipmentLevel || 1)
    };
  });

  app.post("/admin/equipment/forward-available", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const parsed = forwardAvailabilitySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten(), list: [] });
    const { start_at, end_at } = parsed.data;
    if (new Date(end_at).getTime() <= new Date(start_at).getTime()) {
      return reply.code(400).send({ ok: false, error: "End must be after start.", list: [] });
    }

    const inv = await supabaseAdmin
      .from("equipment_items")
      .select("*")
      .eq("status", "AVAILABLE")
      .order("name", { ascending: true });
    if (inv.error) return reply.code(500).send({ ok: false, error: inv.error.message, list: [] });

    const overlaps = await supabaseAdmin
      .from("equipment_reservations")
      .select("equipment_item_id")
      .in("status", EQUIPMENT_ACTIVE_RES_STATUSES)
      .lt("start_at", end_at)
      .gt("end_at", start_at);
    if (overlaps.error) return reply.code(500).send({ ok: false, error: overlaps.error.message, list: [] });

    const busy = new Set((overlaps.data ?? []).map((r) => String(r.equipment_item_id || "")));
    const list = (inv.data ?? [])
      .filter((r) => !busy.has(String(r.id || "")))
      .filter((r) => !String(r.id || "").toUpperCase().startsWith("STUDIO_KEY"))
      .map((r) => ({
        id: String(r.id || ""),
        code: String((r as Record<string, unknown>).equipment_id || r.id || ""),
        name: String(r.name || r.id || ""),
        type: String((r as Record<string, unknown>).category || (r as Record<string, unknown>).type || ""),
        status: String(r.status || "")
      }));
    return { ok: true, list };
  });

  app.get("/admin/equipment/:id/detail", async (req, reply) => {
    const id = String((req.params as { id: string }).id || "").trim();
    if (!id) return reply.code(400).send({ ok: false, error: "Equipment ID required.", history: [] });

    const itemRes = await supabaseAdmin.from("equipment_items").select("*").eq("id", id).limit(1).maybeSingle();
    if (itemRes.error) return reply.code(500).send({ ok: false, error: itemRes.error.message, history: [] });
    if (!itemRes.data) return reply.code(404).send({ ok: false, error: "Equipment not found.", history: [] });

    const res = await supabaseAdmin
      .from("equipment_reservations")
      .select("*")
      .eq("equipment_item_id", id)
      .order("created_at", { ascending: false })
      .limit(30);
    if (res.error) return reply.code(500).send({ ok: false, error: res.error.message, history: [] });

    const rows = res.data ?? [];
    const history = rows.slice(0, 15).map((r) => ({
      user: String(r.requester_name || r.requester_email || ""),
      userId: String(r.requester_profile_id || r.requester_email || ""),
      date: String(r.start_at || r.created_at || ""),
      status: String(r.status || "")
    }));
    const active = rows.find((r) => {
      const s = String(r.status || "").toLowerCase();
      return s === "approved" || s === "in_use" || s === "checked_out" || s === "picked_up" || s === "key_out";
    });
    const previous = rows.length > 1 ? rows[1] : null;
    const item = itemRes.data as Record<string, unknown>;
    const rawStatus = String(item.status || "");
    const location = String(rawStatus || "").toUpperCase() === "AVAILABLE" ? "depot" : "out";
    return {
      ok: true,
      id: String(item.id || ""),
      equipmentCode: String(item.equipment_id || item.id || ""),
      name: String(item.name || item.id || ""),
      type: String(item.category || item.type || ""),
      condition: String(item.condition_in || item.condition_out || "Excellent"),
      level: String(item.required_level || ""),
      photo: String(item.photo_url || item.photo || ""),
      status: rawStatus,
      conditionIn: String(item.condition_in || ""),
      conditionOut: String(item.condition_out || ""),
      statusEnglish: normalizeInvStatusEnglish(rawStatus),
      location,
      locationPhysical: String(item.location || ""),
      responsiblePhysical: String(item.responsible || ""),
      currentUser: active
        ? {
            name: String(active.requester_name || active.requester_email || ""),
            id: String(active.requester_profile_id || active.requester_email || ""),
            returnDate: String(active.end_at || "")
          }
        : null,
      previousUser: previous
        ? {
            name: String(previous.requester_name || previous.requester_email || ""),
            id: String(previous.requester_profile_id || previous.requester_email || ""),
            date: String(previous.start_at || previous.created_at || ""),
            status: String(previous.status || "")
          }
        : null,
      history
    };
  });

  const updateEquipmentMetaHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = String((req.params as { id: string }).id || "").trim();
    if (!id) return reply.code(400).send({ ok: false, error: "Equipment ID required." });
    const parsed = inventoryMetaSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });

    const itemRes = await supabaseAdmin.from("equipment_items").select("*").eq("id", id).limit(1).maybeSingle();
    if (itemRes.error) return reply.code(500).send({ ok: false, error: itemRes.error.message });
    if (!itemRes.data) return reply.code(404).send({ ok: false, error: "Equipment not found." });

    const item = itemRes.data as Record<string, unknown>;
    const incoming = parsed.data;
    const patch: Record<string, unknown> = {};
    if (incoming.location !== undefined && Object.prototype.hasOwnProperty.call(item, "location")) patch.location = incoming.location;
    if (incoming.responsible !== undefined && Object.prototype.hasOwnProperty.call(item, "responsible")) patch.responsible = incoming.responsible;
    if (incoming.condition_in !== undefined && Object.prototype.hasOwnProperty.call(item, "condition_in")) patch.condition_in = incoming.condition_in;
    if (incoming.status !== undefined && Object.prototype.hasOwnProperty.call(item, "status")) patch.status = incoming.status;
    if (!Object.keys(patch).length) return { ok: true, success: true };

    const wasAvailable = String(item.status || "").trim().toUpperCase() === "AVAILABLE";
    const nowAvailable = incoming.status !== undefined && String(incoming.status || "").trim().toUpperCase() === "AVAILABLE";
    const updated = await supabaseAdmin.from("equipment_items").update(patch).eq("id", id).select("id,equipment_id,name").single();
    if (updated.error) return reply.code(500).send({ ok: false, error: updated.error.message });
    let notify: { table: string | null; matched: number; sent: number; failed: number; keys: string[] } | null = null;
    if (!wasAvailable && nowAvailable) {
      try {
        notify = await triggerNotifyForAvailableEquipment(updated.data as Record<string, unknown>, req.log);
      } catch (e) {
        req.log.error({ err: e, equipmentItemId: id }, "trigger available notify failed (meta patch)");
      }
    }
    return { ok: true, success: true, notify };
  };

  app.patch("/admin/equipment/:id/meta", { preHandler: requireRoles(ADMIN_ROLES) }, updateEquipmentMetaHandler);
  app.post("/admin/equipment/:id/meta", { preHandler: requireRoles(ADMIN_ROLES) }, updateEquipmentMetaHandler);

  app.get("/admin/tickets", { preHandler: requireRoles(ADMIN_ROLES) }, async (_req, reply) => {
    const candidates = ["tickets", "support_tickets"];
    for (const table of candidates) {
      const rows = await supabaseAdmin.from(table).select("*").order("created_at", { ascending: false }).limit(200);
      if (!rows.error) return { ok: true, list: rows.data ?? [] };
      if (!isMissingTableError(rows.error)) return reply.code(500).send({ ok: false, error: rows.error.message });
    }
    return { ok: true, list: [] };
  });

  app.post("/admin/tickets/approve", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const actor = getAuthProfile(req);
    const parsed = ticketDecisionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const p = parsed.data;
    const candidates = ["tickets", "support_tickets"];
    for (const table of candidates) {
      const updatePayload =
        table === "tickets"
          ? {
              status: "Onaylandı"
            }
          : {
              status: "Onaylandı",
              admin_note: p.note || "",
              reviewed_by: actor.email,
              reviewed_at: new Date().toISOString()
            };
      const updated = await supabaseAdmin
        .from(table)
        .update(updatePayload)
        .eq("ticket_no", p.ticket_no)
        .in("status", ACTIVE_TICKET_STATUSES)
        .select("ticket_no")
        .single();
      if (!updated.error) return { ok: true, success: true, ticket_no: updated.data?.ticket_no };
      if (!isMissingTableError(updated.error)) return reply.code(500).send({ ok: false, error: updated.error.message });
    }
    return reply.code(501).send({ ok: false, error: "Tickets table is not configured in Supabase." });
  });

  app.post("/admin/tickets/reject", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const actor = getAuthProfile(req);
    const parsed = ticketDecisionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const p = parsed.data;
    const reason = String(p.reason || "").trim();
    if (!reason) return reply.code(400).send({ ok: false, error: "Reject reason required." });
    const candidates = ["tickets", "support_tickets"];
    for (const table of candidates) {
      const updatePayload =
        table === "tickets"
          ? {
              status: "Reddedildi"
            }
          : {
              status: "Reddedildi",
              admin_note: reason,
              reviewed_by: actor.email,
              reviewed_at: new Date().toISOString()
            };
      const updated = await supabaseAdmin
        .from(table)
        .update(updatePayload)
        .eq("ticket_no", p.ticket_no)
        .in("status", ACTIVE_TICKET_STATUSES)
        .select("ticket_no")
        .single();
      if (!updated.error) return { ok: true, success: true, ticket_no: updated.data?.ticket_no };
      if (!isMissingTableError(updated.error)) return reply.code(500).send({ ok: false, error: updated.error.message });
    }
    return reply.code(501).send({ ok: false, error: "Tickets table is not configured in Supabase." });
  });

  app.get("/admin/contact-messages", { preHandler: requireRoles(ADMIN_ROLES) }, async (_req, reply) => {
    const candidates = ["contact_messages", "contact_requests", "support_messages", "bize_contact"];
    for (const table of candidates) {
      const rows = await supabaseAdmin.from(table).select("*").order("created_at", { ascending: false }).limit(300);
      if (rows.error) {
        if (isMissingTableError(rows.error)) continue;
        return reply.code(500).send({ ok: false, error: rows.error.message });
      }
      const list = (rows.data ?? []).map((r: Record<string, unknown>) => ({
        id: String(r.id || ""),
        created_at: String(r.created_at || ""),
        user_id: String(r.requester_profile_id || r.user_id || ""),
        user_name: String(r.requester_name || r.user_name || ""),
        user_email: String(r.requester_email || r.user_email || ""),
        reservation_ref: String(r.reservation_ref || ""),
        message: String(r.message || ""),
        status: String(r.status || ""),
        admin_reply: String(r.admin_reply || ""),
        updated_at: String(r.updated_at || "")
      }));
      return { ok: true, list };
    }
    return { ok: true, list: [] };
  });

  app.post("/admin/contact-messages/reply", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const actor = getAuthProfile(req);
    const parsed = bizeReplySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const payload = parsed.data;
    const candidates = ["contact_messages", "contact_requests", "support_messages", "bize_contact"];
    for (const table of candidates) {
      const updatePayload =
        table === "bize_contact"
          ? {
              admin_reply: payload.reply_text,
              status: "Cevaplandı",
              updated_at: new Date().toISOString()
            }
          : {
              admin_reply: payload.reply_text,
              status: "Cevaplandı",
              reviewed_by: actor.email,
              updated_at: new Date().toISOString()
            };
      const updated = await supabaseAdmin
        .from(table)
        .update(updatePayload)
        .eq("id", payload.row_id)
        .select("id")
        .single();
      if (!updated.error) return { ok: true, success: true, id: String(updated.data?.id || "") };
      if (!isMissingTableError(updated.error)) return reply.code(500).send({ ok: false, error: updated.error.message });
    }
    return reply.code(501).send({ ok: false, error: "Contact table is not configured in Supabase." });
  });

  app.post("/me/bookings/extend", { preHandler: requireAuth }, async (req, reply) => {
    const profile = getAuthProfile(req);
    const parsed = z
      .object({
        id: z.string().min(1),
        equipment_item_id: z.string().min(1),
        new_end_at: isoDateSchema
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const payload = parsed.data;
    const existing = await supabaseAdmin
      .from("equipment_reservations")
      .select("id,equipment_item_id,status,start_at,end_at,requester_profile_id,requester_email")
      .eq("id", payload.id)
      .eq("equipment_item_id", payload.equipment_item_id)
      .limit(1)
      .maybeSingle();
    if (existing.error) return reply.code(500).send({ ok: false, error: existing.error.message });
    if (!existing.data) return reply.code(404).send({ ok: false, error: "Reservation not found." });

    const ownerById = String(existing.data.requester_profile_id || "") === String(profile.id || "");
    const ownerByEmail =
      String(existing.data.requester_email || "").toLowerCase() === String(profile.email || "").toLowerCase();
    if (!ownerById && !ownerByEmail) {
      return reply.code(403).send({ ok: false, error: "Reservation does not belong to current user." });
    }

    const startMs = new Date(String(existing.data.start_at || "")).getTime();
    const endMs = new Date(String(payload.new_end_at || "")).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
      return reply.code(400).send({ ok: false, error: "Invalid extension range." });
    }
    const maxMs = 4 * 24 * 3600 * 1000;
    if (endMs - startMs > maxMs) return reply.code(400).send({ ok: false, error: "EXTEND_MAX_DAYS" });
    if (hasPublicHolidayInRange(String(existing.data.start_at || ""), String(payload.new_end_at || ""))) {
      return reply.code(409).send({ ok: false, error: "Reservations are closed on official public holidays." });
    }
    try {
      await assertDepotSlotCapacity({
        startAt: String(existing.data.start_at || ""),
        endAt: String(payload.new_end_at || ""),
        excludeReservationId: String(payload.id || ""),
        checkStart: false,
        checkEnd: true
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(409).send({ ok: false, error: msg });
    }

    const overlap = await supabaseAdmin
      .from("equipment_reservations")
      .select("id")
      .eq("equipment_item_id", payload.equipment_item_id)
      .in("status", ["pending", "approved", EQUIPMENT_CHECKED_OUT_STATUS, "checked_out", "picked_up", "key_out"])
      .lt("start_at", payload.new_end_at)
      .gt("end_at", String(existing.data.start_at || ""))
      .neq("id", payload.id)
      .limit(1);
    if (overlap.error) return reply.code(500).send({ ok: false, error: overlap.error.message });
    if ((overlap.data ?? []).length > 0) {
      return reply.code(409).send({ ok: false, error: "That equipment is already booked for part of the time you selected." });
    }

    const updated = await supabaseAdmin
      .from("equipment_reservations")
      .update({ end_at: payload.new_end_at })
      .eq("id", payload.id)
      .select("id,end_at")
      .single();
    if (updated.error) return reply.code(500).send({ ok: false, error: updated.error.message });
    return { ok: true, success: true, id: String(updated.data.id || ""), new_end: String(updated.data.end_at || "") };
  });

  app.post("/admin/quick-checkout", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const actor = getAuthProfile(req);
    const actorRecord = actor as unknown as Record<string, unknown>;
    const canUseLevel5 = canOperateLevel5Equipment(actorRecord);
    const parsed = quickCheckoutSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const p = parsed.data;
    const startAt = new Date().toISOString();
    const endAt = p.return_dt || new Date(new Date().setHours(17, 0, 0, 0)).toISOString();
    if (hasPublicHolidayInRange(startAt, endAt)) {
      return reply.code(409).send({ ok: false, error: "Reservations are closed on official public holidays." });
    }
    try {
      await assertDepotSlotCapacity({ startAt, endAt });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(409).send({ ok: false, error: msg });
    }
    const name = String(p.display_name || "").trim() || String(p.email.split("@")[0] || p.email);
    const results: string[] = [];
    const eqIdsForPdf: string[] = [];
    for (const rawId of p.cart_ids) {
      const eqId = String(rawId || "").trim();
      if (!eqId) continue;
      const itemMeta = await supabaseAdmin
        .from("equipment_items")
        .select("id,required_level")
        .eq("id", eqId)
        .limit(1)
        .maybeSingle();
      if (itemMeta.error) return reply.code(500).send({ ok: false, error: itemMeta.error.message });
      if (!itemMeta.data) return reply.code(404).send({ ok: false, error: `Equipment item not found: ${eqId}` });
      const requiredLevel = parseEquipmentLevel((itemMeta.data as Record<string, unknown>).required_level);
      if (requiredLevel >= 5 && !canUseLevel5) {
        return reply.code(403).send({ ok: false, error: "Seviye 5 ekipman için yalnızca super_admin, technician veya senior kullanıcılar hızlı çıkış yapabilir." });
      }
      const created = await insertEquipmentReservationAsCheckedOut({
        equipment_item_id: eqId,
        requester_profile_id: null,
        requester_email: p.email.toLowerCase(),
        requester_name: name,
        required_level: 1,
        approval_required: false,
        start_at: startAt,
        end_at: endAt,
        note: p.project_purpose || "Hızlı Çıkış",
        reviewed_by: String(actor.email || ""),
        reviewed_at: new Date().toISOString()
      });
      if (created.error) return reply.code(500).send({ ok: false, error: created.error.message });
      const rid = String((created.data as Record<string, unknown> | null)?.id || "");
      results.push(rid);
      eqIdsForPdf.push(eqId);
      await supabaseAdmin.from("equipment_items").update({ status: "IN_USE" }).eq("id", eqId);
    }

    let pdfUrl: string | null = null;
    if (eqIdsForPdf.length) {
      const meta = await supabaseAdmin
        .from("equipment_items")
        .select("id,name,equipment_id,condition_out")
        .in("id", eqIdsForPdf);
      if (meta.error) return reply.code(500).send({ ok: false, error: meta.error.message });
      const items = (meta.data ?? []).map((r) => ({
        name: String((r as Record<string, unknown>).name || ""),
        code: String((r as Record<string, unknown>).equipment_id || (r as Record<string, unknown>).id || ""),
        conditionOut: String((r as Record<string, unknown>).condition_out || "")
      }));
      try {
        pdfUrl = await generateCheckoutPdf({
          kind: "equipment",
          reservationId: results[0] || "quick",
          studentName: name,
          studentEmail: p.email.toLowerCase(),
          startAt: startAt,
          endAt: endAt,
          items
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return reply.code(500).send({ ok: false, error: "PDF_GENERATION_FAILED: " + msg });
      }
      const quickEmail = String(p.email || "").trim().toLowerCase();
      if (pdfUrl && quickEmail && quickEmail.includes("@")) {
        try {
          await sendCheckoutPdfAttachmentEmail(quickEmail, {
            kind: "equipment",
            reservationId: results[0] || "quick",
            studentName: name,
            startAt,
            endAt,
            pdfDataUrl: pdfUrl
          });
        } catch (e) {
          req.log.error({ err: e, reservationId: results[0] || "quick", requesterEmail: quickEmail }, "send quick checkout pdf mail failed");
        }
      }
    }

    return { ok: true, success: true, reservation_ids: results, url: pdfUrl || "" };
  });

  app.get("/admin/reports/summary", { preHandler: requireRoles(["super_admin"]) }, async (_req, reply) => {
    const now = Date.now();
    const d30 = new Date(now - 30 * 24 * 3600 * 1000).toISOString();
    const [ticketsRes, eqResRes, studioResRes, itemsRes] = await Promise.all([
      supabaseAdmin.from("tickets").select("*").gte("created_at", d30).order("created_at", { ascending: true }),
      supabaseAdmin.from("equipment_reservations").select("*").order("start_at", { ascending: true }),
      supabaseAdmin.from("studio_reservations").select("*").order("start_at", { ascending: true }),
      supabaseAdmin.from("equipment_items").select("*")
    ]);
    if (ticketsRes.error && !isMissingTableError(ticketsRes.error)) return reply.code(500).send({ ok: false, error: ticketsRes.error.message });
    if (eqResRes.error) return reply.code(500).send({ ok: false, error: eqResRes.error.message });
    if (studioResRes.error) return reply.code(500).send({ ok: false, error: studioResRes.error.message });
    if (itemsRes.error) return reply.code(500).send({ ok: false, error: itemsRes.error.message });

    const tickets = (ticketsRes.data ?? []) as Record<string, unknown>[];
    const eqRows = (eqResRes.data ?? []) as Record<string, unknown>[];
    const studioRows = (studioResRes.data ?? []) as Record<string, unknown>[];
    const items = (itemsRes.data ?? []) as Record<string, unknown>[];

    const ticketStatus = { total: 0, pending: 0, approved: 0, rejected: 0 };
    const byDeptMap = new Map<string, { total: number; approved: number; rejected: number }>();
    const byTypeMap = new Map<string, number>();
    const trendMap = new Map<string, number>();
    tickets.forEach((t) => {
      const status = String(t.status || "").toLowerCase();
      const dept = String(t.department || "Unknown");
      const type = String(t.ticket_type || "Other");
      const day = parseIsoDate(String(t.created_at || ""));
      ticketStatus.total += 1;
      if (status.includes("beklemede") || status.includes("pending")) ticketStatus.pending += 1;
      else if (status.includes("onay")) ticketStatus.approved += 1;
      else if (status.includes("red")) ticketStatus.rejected += 1;
      const dep = byDeptMap.get(dept) || { total: 0, approved: 0, rejected: 0 };
      dep.total += 1;
      if (status.includes("onay")) dep.approved += 1;
      if (status.includes("red")) dep.rejected += 1;
      byDeptMap.set(dept, dep);
      byTypeMap.set(type, (byTypeMap.get(type) || 0) + 1);
      if (day) trendMap.set(day, (trendMap.get(day) || 0) + 1);
    });

    const itemMap = new Map(items.map((i) => [String(i.id || ""), i]));
    const overdue = eqRows
      .filter((r) => {
        const st = String(r.status || "").toLowerCase();
        return ["approved", "in_use", "checked_out", "picked_up", "key_out"].includes(st);
      })
      .filter((r) => {
        const endMs = new Date(String(r.end_at || "")).getTime();
        return !Number.isNaN(endMs) && endMs < now;
      })
      .map((r) => {
        const id = String(r.equipment_item_id || "");
        const it = itemMap.get(id) || {};
        return {
          id,
          name: String((it as Record<string, unknown>).name || id),
          assigned_name: String(r.requester_name || r.requester_email || ""),
          due_date: String(r.end_at || "")
        };
      });

    const studioByMap = new Map<string, { total: number; approved: number; cancelled: number }>();
    studioRows.forEach((r) => {
      const studio = String(r.studio_id || "Unknown");
      const status = String(r.status || "").toLowerCase();
      const row = studioByMap.get(studio) || { total: 0, approved: 0, cancelled: 0 };
      row.total += 1;
      if (status === STUDIO_APPROVED_STATUS || status === STUDIO_PICKED_STATUS || status === "approved") row.approved += 1;
      if (status === STUDIO_CANCELLED_STATUS || status === "cancelled") row.cancelled += 1;
      studioByMap.set(studio, row);
    });

    const eqDemandMap = new Map<string, number>();
    const catDemandMap = new Map<string, number>();
    eqRows.forEach((r) => {
      const id = String(r.equipment_item_id || "");
      if (!id) return;
      eqDemandMap.set(id, (eqDemandMap.get(id) || 0) + 1);
      const cat = String((itemMap.get(id) as Record<string, unknown> | undefined)?.category || "Other");
      catDemandMap.set(cat, (catDemandMap.get(cat) || 0) + 1);
    });

    return {
      ok: true,
      inventory: {
        total: items.length,
        available: items.filter((i) => String(i.status || "").toUpperCase() === "AVAILABLE").length,
        in_use: items.filter((i) => String(i.status || "").toUpperCase() === "IN_USE").length
      },
      overdue,
      overdueCount: overdue.length,
      windowDays: 30,
      tickets: {
        status: ticketStatus,
        byDepartment: Array.from(byDeptMap.entries()).map(([department, d]) => ({
          department,
          total: d.total,
          approved: d.approved,
          rejected: d.rejected,
          approval_rate: d.total ? Math.round((d.approved / d.total) * 100) : 0
        })),
        byType: Array.from(byTypeMap.entries())
          .map(([type, count]) => ({ type, count }))
          .sort((a, b) => b.count - a.count),
        trend: Array.from(trendMap.entries())
          .map(([day, count]) => ({ day, count }))
          .sort((a, b) => (a.day < b.day ? -1 : 1)),
        avgPerDay: Math.round((ticketStatus.total / 30) * 10) / 10
      },
      studio: {
        by_studio: Array.from(studioByMap.entries()).map(([studio, s]) => ({ studio, total: s.total, approved: s.approved, cancelled: s.cancelled }))
      },
      equipmentDemand: {
        top_items: Array.from(eqDemandMap.entries())
          .map(([id, count]) => ({ id, name: String((itemMap.get(id) as Record<string, unknown> | undefined)?.name || id), count }))
          .sort((a, b) => b.count - a.count),
        by_category: Array.from(catDemandMap.entries())
          .map(([category, count]) => ({ category, count }))
          .sort((a, b) => b.count - a.count)
      }
    };
  });

  app.post("/admin/special-access/upsert", { preHandler: requireRoles(["super_admin"]) }, async (req, reply) => {
    const parsed = specialAccessUpsertSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const p = parsed.data;
    const updated = await supabaseAdmin
      .from("profiles")
      .update({ special_access: p.studio, special_access_until: parseIsoDate(p.until) || null, updated_at: new Date().toISOString() })
      .eq("email", p.email.toLowerCase())
      .select("id")
      .single();
    if (updated.error) return reply.code(500).send({ ok: false, error: updated.error.message });
    return { ok: true, success: true };
  });

  app.post("/admin/special-access/delete", { preHandler: requireRoles(["super_admin"]) }, async (req, reply) => {
    const parsed = specialAccessDeleteSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const updated = await supabaseAdmin
      .from("profiles")
      .update({ special_access: null, special_access_until: null, updated_at: new Date().toISOString() })
      .eq("email", parsed.data.email.toLowerCase())
      .select("id")
      .single();
    if (updated.error) return reply.code(500).send({ ok: false, error: updated.error.message });
    return { ok: true, success: true };
  });

  app.get("/admin/special-access/list", { preHandler: requireRoles(["super_admin"]) }, async (_req, reply) => {
    const rows = await supabaseAdmin
      .from("profiles")
      .select("full_name,email,user_type,special_access,special_access_until,special_equipment_access,special_equipment_access_until")
      .or("not.special_access.is.null,not.special_equipment_access.is.null")
      .order("email", { ascending: true });
    if (rows.error) return reply.code(500).send({ ok: false, error: rows.error.message });
    const now = Date.now();
    const list = (rows.data ?? [])
      .filter((r) => String((r as Record<string, unknown>).special_access || "").trim())
      .map((r) => {
        const row = r as Record<string, unknown>;
        const until = String(row.special_access_until || "");
        const t = until ? new Date(until + "T23:59:59.999Z").getTime() : NaN;
        return {
          kind: String(row.user_type || ""),
          name: String(row.full_name || ""),
          email: String(row.email || "").toLowerCase(),
          special_access: String(row.special_access || ""),
          special_access_until: until,
          active: Number.isNaN(t) ? true : t >= now
        };
      });
    const equipment_list = (rows.data ?? [])
      .filter((r) => String((r as Record<string, unknown>).special_equipment_access || "").trim())
      .map((r) => {
        const row = r as Record<string, unknown>;
        const until = String(row.special_equipment_access_until || "");
        const t = until ? new Date(until + "T23:59:59.999Z").getTime() : NaN;
        return {
          kind: String(row.user_type || ""),
          name: String(row.full_name || ""),
          email: String(row.email || "").toLowerCase(),
          special_equipment_access: String(row.special_equipment_access || ""),
          special_equipment_access_until: until,
          active: Number.isNaN(t) ? true : t >= now
        };
      });
    return { ok: true, list, equipment_list };
  });

  app.get("/admin/special-equipment/options", { preHandler: requireRoles(["super_admin"]) }, async (_req, reply) => {
    const rows = await supabaseAdmin
      .from("equipment_items")
      .select("id,name,required_level,status")
      .gte("required_level", 4)
      .order("name", { ascending: true });
    if (rows.error) return reply.code(500).send({ ok: false, error: rows.error.message, list: [] });
    const list = (rows.data ?? [])
      .filter((r) => !String(r.id || "").toUpperCase().startsWith("STUDIO_KEY"))
      .filter((r) => !["DELETED", "HIDDEN", "DAMAGED"].includes(String(r.status || "").toUpperCase()))
      .map((r) => ({ id: String(r.id || ""), name: String(r.name || r.id || ""), eq_level: String(r.required_level || "") }));
    return { ok: true, list };
  });

  app.post("/admin/special-equipment/upsert", { preHandler: requireRoles(["super_admin"]) }, async (req, reply) => {
    const parsed = specialEquipmentUpsertSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const p = parsed.data;
    const eq = await supabaseAdmin.from("equipment_items").select("id,required_level").eq("id", p.equipment_id.toUpperCase()).limit(1).maybeSingle();
    if (eq.error) return reply.code(500).send({ ok: false, error: eq.error.message });
    if (!eq.data) return reply.code(404).send({ ok: false, error: "Equipment not found." });
    if (Number(eq.data.required_level || 0) < 4) {
      return reply.code(400).send({ ok: false, error: "Yalnızca seviye 4-5 ekipman seçilebilir." });
    }
    const updated = await supabaseAdmin
      .from("profiles")
      .update({
        special_equipment_access: p.equipment_id.toUpperCase(),
        special_equipment_access_until: parseIsoDate(p.until) || null,
        updated_at: new Date().toISOString()
      })
      .eq("email", p.email.toLowerCase())
      .select("id")
      .single();
    if (updated.error) return reply.code(500).send({ ok: false, error: updated.error.message });
    return { ok: true, success: true };
  });

  app.post("/admin/special-equipment/delete", { preHandler: requireRoles(["super_admin"]) }, async (req, reply) => {
    const parsed = specialAccessDeleteSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const updated = await supabaseAdmin
      .from("profiles")
      .update({ special_equipment_access: null, special_equipment_access_until: null, updated_at: new Date().toISOString() })
      .eq("email", parsed.data.email.toLowerCase())
      .select("id")
      .single();
    if (updated.error) return reply.code(500).send({ ok: false, error: updated.error.message });
    return { ok: true, success: true };
  });

  app.get("/admin/iiw/tasks", { preHandler: requireRoles(ADMIN_ROLES) }, async (_req, reply) => {
    const candidates = ["iiw_tasks", "iiw_jobs"];
    for (const table of candidates) {
      const rows = await supabaseAdmin.from(table).select("*").order("created_at", { ascending: false }).limit(200);
      if (!rows.error) return { ok: true, list: rows.data ?? [] };
      if (!isMissingTableError(rows.error)) return reply.code(500).send({ ok: false, error: rows.error.message });
    }
    return { ok: true, list: [] };
  });

  app.post("/admin/iiw/hours", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const parsed = iiwSaveHoursSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const p = parsed.data;
    const hoursNum = Number(p.hours);
    if (Number.isNaN(hoursNum) || hoursNum <= 0) return reply.code(400).send({ ok: false, error: "Geçerli saat girin." });
    const candidates = ["iiw_hours", "iiw_task_hours"];
    for (const table of candidates) {
      const created = await supabaseAdmin
        .from(table)
        .insert({
          task_id: p.task_id,
          student_email: p.student_email.toLowerCase(),
          hours: hoursNum,
          created_at: new Date().toISOString()
        })
        .select("id")
        .single();
      if (!created.error) {
        const sum = await supabaseAdmin.from(table).select("hours").eq("task_id", p.task_id).eq("student_email", p.student_email.toLowerCase());
        const total = (sum.data ?? []).reduce((acc, r) => acc + Number((r as { hours?: number }).hours || 0), 0);
        return { ok: true, success: true, total };
      }
      if (!isMissingTableError(created.error)) return reply.code(500).send({ ok: false, error: created.error.message });
    }
    return { ok: false, error: "IIW hours table is not configured." };
  });
};
