import type { FastifyPluginAsync } from "fastify";
import { supabaseAdmin } from "../lib/supabase.js";

export const studioRoutes: FastifyPluginAsync = async (app) => {
  app.get("/studios", async (_, reply) => {
    const { data, error } = await supabaseAdmin
      .from("studios")
      .select("*")
      .order("name", { ascending: true });
    if (error) return reply.code(500).send({ ok: false, error: error.message });
    return { ok: true, data: data ?? [] };
  });

  app.get("/studio-reservations", async (req, reply) => {
    const q = req.query as { status?: string; requester_email?: string; from?: string; to?: string };
    let query = supabaseAdmin.from("studio_reservations").select("*").order("start_at", { ascending: true });
    if (q.status) query = query.eq("status", q.status);
    if (q.requester_email) query = query.eq("requester_email", q.requester_email);
    if (q.from) query = query.gte("start_at", q.from);
    if (q.to) query = query.lte("end_at", q.to);
    const { data, error } = await query;
    if (error) return reply.code(500).send({ ok: false, error: error.message });
    return { ok: true, data: data ?? [] };
  });
};
