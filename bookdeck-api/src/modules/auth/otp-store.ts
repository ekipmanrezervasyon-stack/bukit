type OtpRecord = { code: string; expiresAt: number; attempts: number };
type OtpRequestBucket = { count: number; windowStart: number; blockedUntil: number };

const otpStore = new Map<string, OtpRecord>();
const otpReqByEmail = new Map<string, OtpRequestBucket>();
const otpReqByIp = new Map<string, OtpRequestBucket>();

const OTP_REQUEST_WINDOW_MS = 10 * 60_000;
const OTP_REQUEST_BLOCK_MS = 15 * 60_000;
const OTP_MAX_REQ_PER_EMAIL_WINDOW = 5;
const OTP_MAX_REQ_PER_IP_WINDOW = 25;

const normalizeKey = (raw: string): string => String(raw || "").trim().toLowerCase();

const ensureBucket = (map: Map<string, OtpRequestBucket>, key: string): OtpRequestBucket => {
  const now = Date.now();
  const normalized = normalizeKey(key);
  const existing = map.get(normalized);
  if (!existing) {
    const fresh = { count: 0, windowStart: now, blockedUntil: 0 };
    map.set(normalized, fresh);
    return fresh;
  }
  if (existing.windowStart + OTP_REQUEST_WINDOW_MS <= now) {
    existing.count = 0;
    existing.windowStart = now;
  }
  return existing;
};

const registerOtpRequestInBucket = (
  map: Map<string, OtpRequestBucket>,
  key: string,
  maxPerWindow: number
): { ok: boolean; retryAfterSec: number } => {
  const now = Date.now();
  const normalized = normalizeKey(key);
  if (!normalized) return { ok: true, retryAfterSec: 0 };
  const bucket = ensureBucket(map, normalized);
  if (bucket.blockedUntil > now) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((bucket.blockedUntil - now) / 1000)) };
  }
  bucket.count += 1;
  if (bucket.count > maxPerWindow) {
    bucket.blockedUntil = now + OTP_REQUEST_BLOCK_MS;
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil(OTP_REQUEST_BLOCK_MS / 1000)) };
  }
  return { ok: true, retryAfterSec: 0 };
};

export const setOtp = (email: string, code: string, ttlMs: number) => {
  otpStore.set(normalizeKey(email), {
    code,
    expiresAt: Date.now() + Math.max(30_000, ttlMs),
    attempts: 0
  });
};

export const getOtp = (email: string): OtpRecord | null => {
  const key = normalizeKey(email);
  const rec = otpStore.get(key);
  if (!rec) return null;
  if (rec.expiresAt < Date.now()) {
    otpStore.delete(key);
    return null;
  }
  return rec;
};

export const registerFailedOtpAttempt = (email: string, maxAttempts = 5): { locked: boolean; remaining: number } => {
  const key = normalizeKey(email);
  const rec = otpStore.get(key);
  if (!rec) return { locked: true, remaining: 0 };
  rec.attempts = Number(rec.attempts || 0) + 1;
  if (rec.attempts >= Math.max(1, maxAttempts)) {
    otpStore.delete(key);
    return { locked: true, remaining: 0 };
  }
  return { locked: false, remaining: Math.max(0, maxAttempts - rec.attempts) };
};

export const consumeOtp = (email: string) => {
  otpStore.delete(normalizeKey(email));
};

export const registerOtpRequest = (email: string, ipRaw: string): { ok: boolean; retryAfterSec: number } => {
  const byEmail = registerOtpRequestInBucket(otpReqByEmail, email, OTP_MAX_REQ_PER_EMAIL_WINDOW);
  if (!byEmail.ok) return byEmail;
  const byIp = registerOtpRequestInBucket(otpReqByIp, ipRaw, OTP_MAX_REQ_PER_IP_WINDOW);
  if (!byIp.ok) return byIp;
  return { ok: true, retryAfterSec: 0 };
};
