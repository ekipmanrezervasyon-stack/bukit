import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
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
  status: z.enum(["AVAILABLE", "IN_USE", "BROKEN", "MAINTENANCE"]).optional()
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

const hasPrivilegedStudioAccess = (role: string): boolean =>
  role === "super_admin" || role === "technician" || role === "iiw_instructor" || role === "iiw_admin";

const isSpecialAccessActive = (untilRaw: string): boolean => {
  const until = String(untilRaw || "").trim();
  if (!until) return true;
  const ms = new Date(until).getTime();
  return Number.isFinite(ms) && ms >= Date.now();
};

const canAccessStudioByPolicy = (
  profile: { role?: string; special_access?: string | null; special_access_until?: string | null },
  studioId: string
): boolean => {
  const sid = String(studioId || "").trim().toUpperCase();
  if (!sid) return false;
  if (hasPrivilegedStudioAccess(String(profile.role || ""))) return true;
  if (sid === "GREEN" || sid === "PODCAST" || sid === "DUBBING") return true;
  const specialStudio = String(profile.special_access || "").trim().toUpperCase();
  return sid === specialStudio && isSpecialAccessActive(String(profile.special_access_until || ""));
};

const normalizeInvStatusEnglish = (status: string): string => {
  const s = String(status || "").trim().toUpperCase();
  if (s === "AVAILABLE" || s === "MUSAIT" || s === "MÜSAİT" || s === "UYGUN") return "Available";
  if (s === "IN_USE" || s === "IN USE" || s === "KULLANIMDA" || s === "DISARIDA" || s === "DIŞARIDA") return "In Use";
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

export const reservationRoutes: FastifyPluginAsync = async (app) => {
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
    if (!canAccessStudioByPolicy(profile, studio_id)) {
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
      : await q.eq("student_number", raw).maybeSingle();
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
      studentId: String(p.student_number || p.id || ""),
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
          status: "picked_up",
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
      results.push(String(created.data?.id || ""));
      await supabaseAdmin.from("equipment_items").update({ status: "IN_USE" }).eq("id", eqId);
    }
    return { ok: true, success: true, reservation_ids: results, url: "" };
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
