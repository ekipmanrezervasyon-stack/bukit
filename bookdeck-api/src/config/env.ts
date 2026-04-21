import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default("0.0.0.0"),
  CORS_ORIGIN: z.string().default("https://bilgibooking.com,https://www.bilgibooking.com,http://localhost:3000,http://127.0.0.1:3000"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SESSION_SECRET: z.string().optional().default(""),
  SUPER_ADMIN_EMAIL_ALLOWLIST: z.string().optional().default(""),
  TECHNICIAN_EMAIL_ALLOWLIST: z.string().optional().default(""),
  HEALTH_DEBUG_SECRET: z.string().optional().default(""),
  OTP_DEV_BYPASS: z.string().default("false"),
  OTP_CODE_TTL_MINUTES: z.coerce.number().default(5),
  SESSION_TTL_DAYS: z.coerce.number().default(30),
  RESEND_API_KEY: z.string().optional().default(""),
  OTP_EMAIL_FROM: z.string().optional().default(""),
  OTP_EMAIL_REPLY_TO: z.string().optional().default(""),
  OTP_APP_NAME: z.string().optional().default("BUKit"),
  RETURN_REMINDER_AUTORUN: z.string().default("true"),
  RETURN_REMINDER_INTERVAL_MINUTES: z.coerce.number().default(5),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional().default(""),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().optional().default(""),
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().optional().default(""),
  GOOGLE_EQUIPMENT_FORM_DOC_ID: z.string().optional().default(""),
  GOOGLE_STUDIO_FORM_DOC_ID: z.string().optional().default(""),
  GOOGLE_PDF_FOLDER_ID: z.string().optional().default(""),
  GOOGLE_GREEN_STUDIO_CALENDAR_ID: z.string().optional().default(""),
  GOOGLE_GREEN_STUDIO_ID: z.string().optional().default("")
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid env: ${parsed.error.message}`);
}

if (
  parsed.data.OTP_DEV_BYPASS !== "true" &&
  (!String(parsed.data.RESEND_API_KEY || "").trim() || !String(parsed.data.OTP_EMAIL_FROM || "").trim())
) {
  throw new Error("Invalid env: OTP mail delivery requires RESEND_API_KEY and OTP_EMAIL_FROM when OTP_DEV_BYPASS is false.");
}

if (String(parsed.data.NODE_ENV || "").trim().toLowerCase() === "production" && parsed.data.OTP_DEV_BYPASS === "true") {
  throw new Error("Invalid env: OTP_DEV_BYPASS cannot be true in production.");
}

if (String(parsed.data.NODE_ENV || "").trim().toLowerCase() === "production" && String(parsed.data.SESSION_SECRET || "").trim().length < 32) {
  throw new Error("Invalid env: SESSION_SECRET must be set and at least 32 characters in production.");
}

if (
  String(parsed.data.NODE_ENV || "").trim().toLowerCase() === "production" &&
  !String(parsed.data.SUPER_ADMIN_EMAIL_ALLOWLIST || "").trim()
) {
  throw new Error("Invalid env: SUPER_ADMIN_EMAIL_ALLOWLIST must be set in production.");
}

export const env = parsed.data;
