import type { FastifyPluginAsync } from "fastify";
import { supabaseAdmin } from "../lib/supabase.js";
import { getAuthProfile, requireAuth } from "../modules/auth/guards.js";

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

const canOperateLevel5Equipment = (profile: Record<string, unknown>): boolean => {
  const role = String(profile.role || "").trim().toLowerCase();
  return role === "super_admin" || role === "technician" || parseBoolLike(profile.senior_flag);
};

const canViewLevel5Equipment = (profile: Record<string, unknown>): boolean => {
  const role = String(profile.role || "").trim().toLowerCase();
  if (role === "iiw_instructor" || role === "iiw_admin") return true;
  return canOperateLevel5Equipment(profile);
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
    const visibleRows = canViewLevel5Equipment(profile)
      ? rows
      : rows.filter((r) => parseEquipmentLevel(r.required_level) < 5);

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

  app.get("/equipment-reservations", async (req, reply) => {
    const q = req.query as { status?: string; requester_email?: string };
    let query = supabaseAdmin.from("equipment_reservations").select("*").order("start_at", { ascending: false });
    if (q.status) query = query.eq("status", q.status);
    if (q.requester_email) query = query.eq("requester_email", q.requester_email);
    const { data, error } = await query;
    if (error) return reply.code(500).send({ ok: false, error: error.message });
    return { ok: true, data: data ?? [] };
  });
};
