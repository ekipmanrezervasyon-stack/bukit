import { env } from "../../config/env.js";

const escapeHtml = (v: string): string =>
  String(v || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const sendOtpEmail = async (toEmail: string, code: string, ttlMinutes: number): Promise<void> => {
  const apiKey = String(env.RESEND_API_KEY || "").trim();
  const from = String(env.OTP_EMAIL_FROM || "").trim();
  if (!apiKey || !from) {
    throw new Error("OTP mail delivery is not configured. Missing RESEND_API_KEY or OTP_EMAIL_FROM.");
  }

  const appName = String(env.OTP_APP_NAME || "BUKit").trim();
  const subject = `${appName} OTP Login Code`;
  const safeCode = escapeHtml(code);
  const safeTo = escapeHtml(toEmail);
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;line-height:1.45;color:#111827">
      <h2 style="margin:0 0 12px 0;color:#111827">${escapeHtml(appName)} - One-Time Password</h2>
      <p style="margin:0 0 12px 0;">Use the code below to complete your sign in:</p>
      <p style="margin:0 0 16px 0;font-size:28px;font-weight:800;letter-spacing:4px;color:#e30613">${safeCode}</p>
      <p style="margin:0 0 6px 0;">This code expires in ${Number(ttlMinutes)} minute(s).</p>
      <p style="margin:0;color:#6b7280;font-size:12px">Requested for: ${safeTo}</p>
    </div>
  `;
  const text = `${appName} OTP code: ${code}\nExpires in ${Number(ttlMinutes)} minute(s).\nRequested for: ${toEmail}`;

  const payload: Record<string, unknown> = {
    from,
    to: [toEmail],
    subject,
    html,
    text
  };
  if (env.OTP_EMAIL_REPLY_TO) payload.reply_to = env.OTP_EMAIL_REPLY_TO;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const raw = await resp.text();
    throw new Error(`Resend send failed (${resp.status}): ${raw || resp.statusText}`);
  }
};
