import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default("0.0.0.0"),
  CORS_ORIGIN: z.string().default("*"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  OTP_DEV_BYPASS: z.string().default("true"),
  OTP_CODE_TTL_MINUTES: z.coerce.number().default(5),
  SESSION_TTL_DAYS: z.coerce.number().default(30),
  RESEND_API_KEY: z.string().optional().default(""),
  OTP_EMAIL_FROM: z.string().optional().default(""),
  OTP_EMAIL_REPLY_TO: z.string().optional().default(""),
  OTP_APP_NAME: z.string().optional().default("BUKit")
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid env: ${parsed.error.message}`);
}

export const env = parsed.data;
