type OtpRecord = { code: string; expiresAt: number; attempts: number };

const otpStore = new Map<string, OtpRecord>();

export const setOtp = (email: string, code: string, ttlMs: number) => {
  otpStore.set(email.toLowerCase().trim(), {
    code,
    expiresAt: Date.now() + Math.max(30_000, ttlMs),
    attempts: 0
  });
};

export const getOtp = (email: string): OtpRecord | null => {
  const rec = otpStore.get(email.toLowerCase().trim());
  if (!rec) return null;
  if (rec.expiresAt < Date.now()) {
    otpStore.delete(email.toLowerCase().trim());
    return null;
  }
  return rec;
};

export const consumeOtp = (email: string) => {
  otpStore.delete(email.toLowerCase().trim());
};
