import type { FastifyPluginAsync } from "fastify";
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
const ACTIVE_RES_STATUSES = ["pending", "approved", "checked_out", "picked_up", "key_out"];
const CLOSED_RES_STATUSES = ["cancelled", "rejected", "returned", "completed"];
const ACTIVE_TICKET_STATUSES = ["pending", "beklemede", "beklemede / pending"];
const ON_LOAN_RES_STATUSES = ["checked_out", "picked_up", "key_out"];

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
  return ACTIVE_RES_STATUSES.includes(s) && !CLOSED_RES_STATUSES.includes(s);
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

  const loanRowsRes = await supabaseAdmin
    .from("equipment_reservations")
    .select("id,equipment_item_id,start_at,end_at,status")
    .or(ownerFilter)
    .in("status", ON_LOAN_RES_STATUSES)
    .order("end_at", { ascending: true });
  if (loanRowsRes.error) throw new Error(loanRowsRes.error.message);

  const loanRows = (loanRowsRes.data ?? []) as Record<string, unknown>[];
  const eqIds = Array.from(new Set(loanRows.map((r) => String(r.equipment_item_id || "")).filter(Boolean)));
  const eqMetaRes = eqIds.length
    ? await supabaseAdmin.from("equipment_items").select("id,name,equipment_id").in("id", eqIds)
    : { data: [], error: null };
  if (eqMetaRes.error) throw new Error(eqMetaRes.error.message);
  const eqMetaById = new Map(
    ((eqMetaRes.data ?? []) as Record<string, unknown>[]).map((r) => [
      String(r.id || ""),
      {
        name: String(r.name || r.id || ""),
        code: String(r.equipment_id || r.id || "")
      }
    ])
  );

  const loans: DashboardLoan[] = loanRows.map((r) => {
    const due = String(r.end_at || "");
    const dueMs = due ? new Date(due).getTime() : NaN;
    const meta = eqMetaById.get(String(r.equipment_item_id || "")) || { name: String(r.equipment_item_id || ""), code: String(r.equipment_item_id || "") };
    return {
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
    .in("status", ACTIVE_RES_STATUSES)
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
  const activeForOverdue = Array.from(new Set(["approved", ...ON_LOAN_RES_STATUSES]));
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
    if (["cancelled", "rejected", "returned", "completed"].includes(status)) {
      return { ok: true, already_closed: true, id, status };
    }

    const updated = await supabaseAdmin
      .from(table)
      .update({
        status: "cancelled",
        reviewed_by: String(profile.email || ""),
        reviewed_at: new Date().toISOString()
      })
      .eq("id", id)
      .select("id,status")
      .single();
    if (updated.error) return reply.code(500).send({ ok: false, error: updated.error.message });
    return { ok: true, id: String(updated.data.id || id), status: String(updated.data.status || "cancelled") };
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
      .in("status", ["pending", "approved"])
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
      status: isAdminRole(profile.role) ? "approved" : "pending",
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
    const matrix = resolveAccessMatrix(profile as Record<string, unknown>);
    const requiredLevel = parseEquipmentLevel((item as Record<string, unknown>).required_level);
    if (requiredLevel > matrix.maxEquipmentLevel) {
      return reply
        .code(403)
        .send({ ok: false, error: `Bu ekipman seviye ${requiredLevel} yetkisi gerektirir. Hesabinizin azami seviyesi ${matrix.maxEquipmentLevel}.` });
    }

    const overlap = await supabaseAdmin
      .from("equipment_reservations")
      .select("id,status,requester_profile_id,requester_email,start_at,end_at")
      .eq("equipment_item_id", equipment_item_id)
      .in("status", ["pending", "approved", "checked_out"])
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
        status: "approved",
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
        status: "rejected",
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
    const parsed = adminTrafficActionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const id = String(parsed.data.id || "").trim();
    const selectedItemIds = dedupeTrimmedIds(parsed.data.item_ids);
    const checkoutConditionMap = parsed.data.checkout_condition_map || {};
    const studioHandoverNote = String(parsed.data.studio_handover_note || "").trim();
    const nowIso = new Date().toISOString();

    const eq = await supabaseAdmin
      .from("equipment_reservations")
      .update({
        status: "checked_out",
        reviewed_by: actor.email,
        reviewed_at: nowIso
      })
      .eq("id", id)
      .select("id,equipment_item_id,status,start_at,end_at,requester_name,requester_email,requester_profile_id,required_level,note")
      .maybeSingle();
    if (eq.error) return reply.code(500).send({ ok: false, error: eq.error.message });
    if (eq.data) {
      const eqRes = eq.data as Record<string, unknown>;
      const eqId = String(eqRes.equipment_item_id || "").trim();
      const allItemIds = dedupeTrimmedIds([eqId, ...selectedItemIds]);
      let pdfUrl: string | null = null;
      if (allItemIds.length) {
        const itemsForPdf: Array<{ name: string; code: string; conditionOut: string }> = [];
        const reservationStartAt = String(eqRes.start_at || "");
        const reservationEndAt = String(eqRes.end_at || "");
        const requesterProfileId = eqRes.requester_profile_id ? String(eqRes.requester_profile_id) : null;
        const requiredLevelRaw = Number(eqRes.required_level);
        const requiredLevel = Number.isFinite(requiredLevelRaw) ? requiredLevelRaw : 1;
        const reservationNote = String(eqRes.note || "");
        const requesterEmail = String(eqRes.requester_email || "").toLowerCase();
        const requesterName = String(eqRes.requester_name || "");

        for (const itemId of allItemIds) {
          const patch: Record<string, unknown> = { status: "IN_USE" };
          const condOut = findMappedConditionOut(checkoutConditionMap, itemId);
          if (condOut) patch.condition_out = condOut;

          const updItem = await supabaseAdmin
            .from("equipment_items")
            .update(patch)
            .eq("id", itemId)
            .select("id,name,equipment_id,condition_out")
            .maybeSingle();
          if (updItem.error) return reply.code(500).send({ ok: false, error: updItem.error.message });
          const itemRow = updItem.data as Record<string, unknown> | null;
          if (!itemRow) {
            return reply.code(404).send({ ok: false, error: `Equipment item not found: ${itemId}` });
          }

          if (itemId !== eqId) {
            const existingExtra = await supabaseAdmin
              .from("equipment_reservations")
              .select("id,status")
              .eq("equipment_item_id", itemId)
              .eq("requester_email", requesterEmail)
              .eq("start_at", reservationStartAt)
              .eq("end_at", reservationEndAt)
              .in("status", ACTIVE_RES_STATUSES)
              .limit(1);
            if (existingExtra.error) {
              return reply.code(500).send({ ok: false, error: existingExtra.error.message });
            }
            if ((existingExtra.data ?? []).length === 0) {
              const createdExtra = await supabaseAdmin
                .from("equipment_reservations")
                .insert({
                  equipment_item_id: itemId,
                  requester_profile_id: requesterProfileId,
                  requester_email: requesterEmail,
                  requester_name: requesterName,
                  required_level: requiredLevel,
                  status: "checked_out",
                  approval_required: false,
                  start_at: reservationStartAt,
                  end_at: reservationEndAt,
                  note: reservationNote,
                  reviewed_by: String(actor.email || ""),
                  reviewed_at: nowIso
                })
                .select("id")
                .single();
              if (createdExtra.error) {
                return reply.code(500).send({ ok: false, error: createdExtra.error.message });
              }
            } else {
              const existingId = String((existingExtra.data?.[0] as Record<string, unknown> | undefined)?.id || "").trim();
              if (existingId) {
                const normalizedPatch: Record<string, unknown> = {
                  status: "checked_out",
                  reviewed_by: String(actor.email || ""),
                  reviewed_at: nowIso
                };
                const updExisting = await supabaseAdmin
                  .from("equipment_reservations")
                  .update(normalizedPatch)
                  .eq("id", existingId)
                  .select("id")
                  .single();
                if (updExisting.error) {
                  return reply.code(500).send({ ok: false, error: updExisting.error.message });
                }
              }
            }
          }

          itemsForPdf.push({
            name: String(itemRow.name || ""),
            code: String(itemRow.equipment_id || itemId),
            conditionOut: String(itemRow.condition_out || "")
          });
        }

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
      }
      return { ok: true, success: true, id, status: "checked_out", url: pdfUrl || "" };
    }

    const st = await supabaseAdmin
      .from("studio_reservations")
      .update({
        reviewed_by: actor.email,
        reviewed_at: nowIso
      })
      .eq("id", id)
      .select("id,status,start_at,end_at,requester_name,requester_email,studio_name")
      .maybeSingle();
    if (st.error) return reply.code(500).send({ ok: false, error: st.error.message });
    if (st.data) {
      try {
        const pdfUrl = await generateCheckoutPdf({
          kind: "studio",
          reservationId: String((st.data as Record<string, unknown>).id || id),
          studentName: String((st.data as Record<string, unknown>).requester_name || ""),
          studentEmail: String((st.data as Record<string, unknown>).requester_email || ""),
          startAt: String((st.data as Record<string, unknown>).start_at || ""),
          endAt: String((st.data as Record<string, unknown>).end_at || ""),
          studioName: String((st.data as Record<string, unknown>).studio_name || ""),
          handoverNote: studioHandoverNote
        });
        return {
          ok: true,
          success: true,
          id,
          status: String((st.data as Record<string, unknown>).status || "approved"),
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
      if (!ON_LOAN_RES_STATUSES.includes(currentStatus)) {
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
      if (eqId) {
        const updItem = await supabaseAdmin.from("equipment_items").update({ status: "AVAILABLE" }).eq("id", eqId);
        if (updItem.error) return reply.code(500).send({ ok: false, error: updItem.error.message });
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

      return { ok: true, success: true, id, status: "returned", penalty };
    }

    const st = await supabaseAdmin
      .from("studio_reservations")
      .update({
        reviewed_by: actor.email,
        reviewed_at: nowIso
      })
      .eq("id", id)
      .select("id,status")
      .maybeSingle();
    if (st.error) return reply.code(500).send({ ok: false, error: st.error.message });
    if (st.data) return { ok: true, success: true, id, status: String((st.data as Record<string, unknown>).status || "approved") };

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
      if (eqId) await supabaseAdmin.from("equipment_items").update({ status: "AVAILABLE" }).eq("id", eqId);
      return { ok: true, success: true, id, status: "cancelled" };
    }

    const st = await supabaseAdmin
      .from("studio_reservations")
      .update({
        status: "cancelled",
        reviewed_by: actor.email,
        reviewed_at: new Date().toISOString()
      })
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (st.error) return reply.code(500).send({ ok: false, error: st.error.message });
    if (st.data) return { ok: true, success: true, id, status: "cancelled" };
    return reply.code(404).send({ ok: false, error: "Reservation not found." });
  });

  app.post("/admin/traffic/extend", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const parsed = adminTrafficExtendSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const id = String(parsed.data.id || "").trim();
    const newEndAt = String(parsed.data.new_end_at || "");

    const eq = await supabaseAdmin
      .from("equipment_reservations")
      .update({ end_at: newEndAt, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("id,end_at")
      .maybeSingle();
    if (eq.error) return reply.code(500).send({ ok: false, error: eq.error.message });
    if (eq.data) return { ok: true, success: true, id, end_at: newEndAt };

    const st = await supabaseAdmin
      .from("studio_reservations")
      .update({ end_at: newEndAt, updated_at: new Date().toISOString() })
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
    const isEmail = raw.includes("@");
    const q = supabaseAdmin.from("profiles").select("*").limit(1);
    const user = isEmail
      ? await q.eq("email", raw.toLowerCase()).maybeSingle()
      : await q.or(`student_number.eq.${raw},staff_number.eq.${raw}`).maybeSingle();
    if (user.error) return reply.code(500).send({ ok: false, error: user.error.message });
    if (!user.data) return reply.code(404).send({ ok: false, error: "Target user not found." });
    const p = user.data as Record<string, unknown>;
    const payload = {
      requester_profile_id: String(p.id || ""),
      requester_email: String(p.email || "").toLowerCase(),
      requester_name: String(p.full_name || p.email || "")
    };

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
    const candidates = ["equipment_notify_subscriptions", "equipment_notify", "notify_subscriptions"];
    for (const table of candidates) {
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
    const q = supabaseAdmin.from("profiles").select("*").limit(1);
    const result = isEmail
      ? await q.eq("email", raw.toLowerCase()).maybeSingle()
      : await q.or(`student_number.eq.${raw},staff_number.eq.${raw}`).maybeSingle();
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
      studentId: String(p.student_number || p.staff_number || p.id || ""),
      level: String(p.access_override_level || "1")
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
      .in("status", ACTIVE_RES_STATUSES)
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
      return s === "approved" || s === "checked_out" || s === "picked_up" || s === "key_out";
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

  app.patch("/admin/equipment/:id/meta", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
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

    const updated = await supabaseAdmin.from("equipment_items").update(patch).eq("id", id).select("id").single();
    if (updated.error) return reply.code(500).send({ ok: false, error: updated.error.message });
    return { ok: true, success: true };
  });

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

    const overlap = await supabaseAdmin
      .from("equipment_reservations")
      .select("id")
      .eq("equipment_item_id", payload.equipment_item_id)
      .in("status", ["pending", "approved", "checked_out", "picked_up", "key_out"])
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
      .update({ end_at: payload.new_end_at, updated_at: new Date().toISOString() })
      .eq("id", payload.id)
      .select("id,end_at")
      .single();
    if (updated.error) return reply.code(500).send({ ok: false, error: updated.error.message });
    return { ok: true, success: true, id: String(updated.data.id || ""), new_end: String(updated.data.end_at || "") };
  });

  app.post("/admin/quick-checkout", { preHandler: requireRoles(ADMIN_ROLES) }, async (req, reply) => {
    const actor = getAuthProfile(req);
    const parsed = quickCheckoutSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const p = parsed.data;
    const startAt = new Date().toISOString();
    const endAt = p.return_dt || new Date(new Date().setHours(17, 0, 0, 0)).toISOString();
    if (hasPublicHolidayInRange(startAt, endAt)) {
      return reply.code(409).send({ ok: false, error: "Reservations are closed on official public holidays." });
    }
    const name = String(p.display_name || "").trim() || String(p.email.split("@")[0] || p.email);
    const results: string[] = [];
    const eqIdsForPdf: string[] = [];
    for (const rawId of p.cart_ids) {
      const eqId = String(rawId || "").trim();
      if (!eqId) continue;
      const created = await supabaseAdmin
        .from("equipment_reservations")
        .insert({
          equipment_item_id: eqId,
          requester_profile_id: null,
          requester_email: p.email.toLowerCase(),
          requester_name: name,
          required_level: 1,
          status: "checked_out",
          approval_required: false,
          start_at: startAt,
          end_at: endAt,
          note: p.project_purpose || "Hızlı Çıkış",
          reviewed_by: String(actor.email || ""),
          reviewed_at: new Date().toISOString()
        })
        .select("id")
        .single();
      if (created.error) return reply.code(500).send({ ok: false, error: created.error.message });
      const rid = String(created.data?.id || "");
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
        return ["approved", "checked_out", "picked_up", "key_out"].includes(st);
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
      if (status === "approved") row.approved += 1;
      if (status === "cancelled") row.cancelled += 1;
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
