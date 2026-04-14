import type { FastifyPluginAsync } from "fastify";
import { supabaseAdmin } from "../lib/supabase.js";
import { env } from "../config/env.js";

export const supabaseHealthRoutes: FastifyPluginAsync = async (app) => {
  const errorToText = (e: unknown): string => {
    if (e instanceof Error) return e.message || e.name;
    if (typeof e === "string") return e;
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  };

  const withTimeout = async <T>(p: PromiseLike<T>, ms: number, label: string): Promise<T> => {
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms (${label})`)), ms);
    });
    try {
      return await Promise.race([Promise.resolve(p), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  app.get("/health/supabase", async (_, reply) => {
    const checks: Record<string, { ok: boolean; count?: number; error?: string }> = {};
    const tables = ["profiles", "equipment_items", "studios", "equipment_reservations", "studio_reservations"];
    const results = await Promise.all(
      tables.map(async (table) => {
        try {
          const r = await withTimeout<{ count: number | null; error: { message: string } | null }>(
            supabaseAdmin.from(table).select("*", { count: "exact", head: true }),
            5000,
            table
          );
          if (r.error) {
            return { table, check: { ok: false, error: errorToText(r.error) } };
          }
          return { table, check: { ok: true, count: r.count ?? 0 } };
        } catch (e) {
          return {
            table,
            check: { ok: false, error: errorToText(e) }
          };
        }
      })
    );
    for (const row of results) {
      checks[row.table] = row.check;
    }

    const hasError = Object.values(checks).some((x) => !x.ok);
    if (hasError) {
      return reply.code(500).send({ ok: false, checks });
    }
    return { ok: true, checks };
  });

  app.get("/health/supabase/raw", async (_, reply) => {
    try {
      const url = `${env.SUPABASE_URL}/rest/v1/profiles?select=id&limit=1`;
      const resp = await fetch(url, {
        method: "GET",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          Accept: "application/json"
        }
      });
      const text = await resp.text();
      const tokenParts = env.SUPABASE_SERVICE_ROLE_KEY.split(".");
      let tokenPayload: Record<string, unknown> = {};
      if (tokenParts.length >= 2) {
        try {
          tokenPayload = JSON.parse(Buffer.from(tokenParts[1], "base64url").toString("utf8"));
        } catch (_e) {}
      }
      return reply.code(resp.ok ? 200 : 500).send({
        ok: resp.ok,
        status: resp.status,
        statusText: resp.statusText,
        body: text,
        tokenInfo: {
          role: tokenPayload.role ?? null,
          ref: tokenPayload.ref ?? null,
          iss: tokenPayload.iss ?? null,
          exp: tokenPayload.exp ?? null
        }
      });
    } catch (e) {
      return reply.code(500).send({
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      });
    }
  });
};
