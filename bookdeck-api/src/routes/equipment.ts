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
    if (canViewLevel5Equipment(profile)) return { ok: true, data: rows };
    return {
      ok: true,
      data: rows.filter((r) => parseEquipmentLevel(r.required_level) < 5)
    };
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
