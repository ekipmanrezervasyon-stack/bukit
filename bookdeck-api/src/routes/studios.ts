import type { FastifyPluginAsync } from "fastify";
import { supabaseAdmin } from "../lib/supabase.js";
import { getAuthProfile, requireAuth } from "../modules/auth/guards.js";

const hasPrivilegedStudioAccess = (role: string): boolean =>
  role === "super_admin" || role === "technician" || role === "iiw_instructor" || role === "iiw_admin";

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

export const studioRoutes: FastifyPluginAsync = async (app) => {
  app.get("/studios", { preHandler: requireAuth }, async (req, reply) => {
    const profile = getAuthProfile(req);
    const { data, error } = await supabaseAdmin
      .from("studios")
      .select("*")
      .order("name", { ascending: true });
    if (error) return reply.code(500).send({ ok: false, error: error.message });

    const rows = (data ?? []) as Record<string, unknown>[];
    let visible = rows;
    if (!hasPrivilegedStudioAccess(String(profile.role || ""))) {
      const allowed = new Set(["GREEN", "PODCAST", "DUBBING"]);
      const specialStudio = String(profile.special_access || "").trim().toUpperCase();
      if (specialStudio && isSpecialAccessActive(String(profile.special_access_until || ""))) {
        allowed.add(specialStudio);
      }
      visible = rows.filter((row) => allowed.has(resolveStudioKey(row)));
    }

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
