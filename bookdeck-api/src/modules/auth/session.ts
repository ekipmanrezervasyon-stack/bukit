import crypto from "node:crypto";
import { env } from "../../config/env.js";

type SessionPayload = {
  sub: string;
  email: string;
  role: string;
  exp: number;
};

const sessionSecret = env.SUPABASE_SERVICE_ROLE_KEY;

const base64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

export const createSessionToken = (payload: Omit<SessionPayload, "exp">, ttlSeconds: number): string => {
  const body: SessionPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + Math.max(60, ttlSeconds)
  };
  const encoded = base64url(JSON.stringify(body));
  const sig = crypto.createHmac("sha256", sessionSecret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
};

export const verifySessionToken = (token: string): SessionPayload | null => {
  const raw = String(token || "").trim();
  if (!raw || raw.indexOf(".") < 0) return null;
  const [encoded, sig] = raw.split(".");
  if (!encoded || !sig) return null;
  const expected = crypto.createHmac("sha256", sessionSecret).update(encoded).digest("base64url");
  if (expected !== sig) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    if (!payload || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
};
