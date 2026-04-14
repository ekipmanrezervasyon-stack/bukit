import type { FastifyPluginAsync } from "fastify";
import { supabaseAdmin } from "../lib/supabase.js";

export const equipmentRoutes: FastifyPluginAsync = async (app) => {
  app.get("/equipment-items", async (req, reply) => {
    const q = req.query as { status?: string; category?: string; search?: string };
    let query = supabaseAdmin.from("equipment_items").select("*").order("name", { ascending: true });
    if (q.status) query = query.eq("status", q.status);
    if (q.category) query = query.eq("category", q.category);
    if (q.search) query = query.ilike("name", `%${q.search}%`);
    const { data, error } = await query;
    if (error) return reply.code(500).send({ ok: false, error: error.message });
    return { ok: true, data: data ?? [] };
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
