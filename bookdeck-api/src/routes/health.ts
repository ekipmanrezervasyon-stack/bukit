import type { FastifyPluginAsync } from "fastify";
import { supabaseAdmin } from "../lib/supabase.js";

const parseBoolLike = (raw: unknown): boolean => {
  if (typeof raw === "boolean") return raw;
  const s = String(raw || "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
};

const isMissingSchemaError = (err: unknown): boolean => {
  const msg =
    typeof err === "string"
      ? err
      : err && typeof err === "object" && "message" in err
        ? String((err as { message?: string }).message || "")
        : "";
  return msg.includes("Could not find the table") || msg.includes("relation") || msg.includes("does not exist");
};

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => {
    return { ok: true, service: "bookdeck-api", ts: new Date().toISOString() };
  });

  app.get("/maintenance", async (_req, reply) => {
    const defaults = {
      ok: true,
      enabled: false,
      admin_enabled: false,
      message: "Sistem geçici olarak bakım modunda. Lütfen kısa süre sonra tekrar deneyin.",
      admin_message: "Admin paneli geçici olarak bakım modunda. Lütfen kısa süre sonra tekrar deneyin.",
      ts: new Date().toISOString()
    };
    const q = await supabaseAdmin
      .from("app_config")
      .select("key,value")
      .in("key", ["maintenance_mode", "maintenance_admin_mode", "maintenance_message", "maintenance_admin_message"]);
    if (q.error) {
      if (isMissingSchemaError(q.error)) return defaults;
      return reply.code(500).send({ ok: false, error: q.error.message });
    }
    const map = new Map<string, string>();
    for (const r of (q.data ?? []) as Array<Record<string, unknown>>) {
      const k = String(r.key || "").trim();
      if (!k) continue;
      map.set(k, String(r.value || ""));
    }
    const globalEnabled = parseBoolLike(map.get("maintenance_mode"));
    const adminEnabledRaw = map.get("maintenance_admin_mode");
    const adminEnabled = adminEnabledRaw == null ? globalEnabled : parseBoolLike(adminEnabledRaw);
    const message = String(map.get("maintenance_message") || defaults.message).trim() || defaults.message;
    const adminMessage = String(map.get("maintenance_admin_message") || message || defaults.admin_message).trim() || defaults.admin_message;
    return {
      ok: true,
      enabled: globalEnabled,
      admin_enabled: adminEnabled,
      message,
      admin_message: adminMessage,
      ts: new Date().toISOString()
    };
  });
};
