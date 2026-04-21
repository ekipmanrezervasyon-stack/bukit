import { google } from "googleapis";
import { env } from "../config/env.js";
import { supabaseAdmin } from "./supabase.js";

type StudioSyncPayload = {
  reservationId: string;
  studioId: string;
  startAt: string;
  endAt: string;
  requesterName?: string;
  requesterEmail?: string;
  purpose?: string;
};

const CAL_SCOPE = ["https://www.googleapis.com/auth/calendar"];
const RESERVATION_EXT_KEY = "bookdeck_reservation_id";
let greenStudioIdCache: string | null | undefined;

const normalize = (v: unknown): string => String(v ?? "").trim();

const parseServiceAccountCredentials = (): { client_email: string; private_key: string } | null => {
  const rawJson = normalize(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      const clientEmail = normalize(parsed.client_email);
      const privateKey = normalize(parsed.private_key).replace(/\\n/g, "\n");
      if (clientEmail && privateKey) return { client_email: clientEmail, private_key: privateKey };
    } catch {
      // fallback to split env vars
    }
  }
  const clientEmail = normalize(env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  const privateKey = normalize(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY).replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return null;
  return { client_email: clientEmail, private_key: privateKey };
};

const getCalendarClient = () => {
  const credentials = parseServiceAccountCredentials();
  if (!credentials) return null;
  const auth = new google.auth.GoogleAuth({ credentials, scopes: CAL_SCOPE });
  return google.calendar({ version: "v3", auth });
};

const resolveGreenStudioId = async (): Promise<string | null> => {
  if (greenStudioIdCache !== undefined) return greenStudioIdCache;
  const envStudioId = normalize(env.GOOGLE_GREEN_STUDIO_ID);
  if (envStudioId) {
    greenStudioIdCache = envStudioId;
    return greenStudioIdCache;
  }
  const found = await supabaseAdmin
    .from("studios")
    .select("id,name")
    .ilike("name", "%GREEN%")
    .limit(1)
    .maybeSingle();
  if (found.error || !found.data) {
    greenStudioIdCache = null;
    return null;
  }
  greenStudioIdCache = normalize((found.data as Record<string, unknown>).id);
  return greenStudioIdCache;
};

const buildDescription = (p: StudioSyncPayload): string => {
  const parts = [
    `BookDeck Reservation: ${normalize(p.reservationId)}`,
    `Studio ID: ${normalize(p.studioId)}`,
    `Requester: ${normalize(p.requesterName) || "-"}`,
    `Email: ${normalize(p.requesterEmail) || "-"}`,
    `Purpose: ${normalize(p.purpose) || "-"}`
  ];
  return parts.join("\n");
};

const listEventsByReservation = async (calendarId: string, reservationId: string) => {
  const cal = getCalendarClient();
  if (!cal) return [];
  const res = await cal.events.list({
    calendarId,
    privateExtendedProperty: [`${RESERVATION_EXT_KEY}=${reservationId}`],
    maxResults: 10,
    singleEvents: true,
    showDeleted: false
  });
  return Array.isArray(res.data.items) ? res.data.items : [];
};

export const upsertApprovedGreenStudioToGoogleCalendar = async (payload: StudioSyncPayload): Promise<{ ok: boolean; skipped?: string; eventId?: string }> => {
  const calendarId = normalize(env.GOOGLE_GREEN_STUDIO_CALENDAR_ID);
  if (!calendarId) return { ok: false, skipped: "missing_calendar_id" };
  const reservationId = normalize(payload.reservationId);
  const studioId = normalize(payload.studioId);
  if (!reservationId || !studioId) return { ok: false, skipped: "missing_payload" };
  const greenStudioId = await resolveGreenStudioId();
  if (!greenStudioId || studioId !== greenStudioId) return { ok: false, skipped: "not_green_studio" };
  const startAt = normalize(payload.startAt);
  const endAt = normalize(payload.endAt);
  if (!startAt || !endAt) return { ok: false, skipped: "missing_datetime" };

  const cal = getCalendarClient();
  if (!cal) return { ok: false, skipped: "missing_service_account" };

  const body = {
    summary: `GREEN STÜDYO · ${normalize(payload.requesterName) || normalize(payload.requesterEmail) || "Rezervasyon"}`,
    description: buildDescription(payload),
    start: { dateTime: startAt, timeZone: "Europe/Istanbul" },
    end: { dateTime: endAt, timeZone: "Europe/Istanbul" },
    status: "confirmed",
    extendedProperties: {
      private: {
        [RESERVATION_EXT_KEY]: reservationId
      }
    }
  };

  const existing = await listEventsByReservation(calendarId, reservationId);
  const current = existing.find((x: { id?: string | null }) => normalize(x.id));
  if (current && normalize(current.id)) {
    const patched = await cal.events.patch({
      calendarId,
      eventId: String(current.id),
      requestBody: body,
      sendUpdates: "none"
    });
    return { ok: true, eventId: normalize(patched.data.id || current.id) };
  }

  const created = await cal.events.insert({
    calendarId,
    requestBody: body,
    sendUpdates: "none"
  });
  return { ok: true, eventId: normalize(created.data.id) };
};

export const deleteGreenStudioFromGoogleCalendar = async (payload: { reservationId: string; studioId: string }): Promise<{ ok: boolean; skipped?: string; deleted?: number }> => {
  const calendarId = normalize(env.GOOGLE_GREEN_STUDIO_CALENDAR_ID);
  if (!calendarId) return { ok: false, skipped: "missing_calendar_id" };
  const reservationId = normalize(payload.reservationId);
  const studioId = normalize(payload.studioId);
  if (!reservationId || !studioId) return { ok: false, skipped: "missing_payload" };
  const greenStudioId = await resolveGreenStudioId();
  if (!greenStudioId || studioId !== greenStudioId) return { ok: false, skipped: "not_green_studio" };
  const cal = getCalendarClient();
  if (!cal) return { ok: false, skipped: "missing_service_account" };

  const existing = await listEventsByReservation(calendarId, reservationId);
  let deleted = 0;
  for (const ev of existing) {
    const eventId = normalize(ev.id);
    if (!eventId) continue;
    await cal.events.delete({
      calendarId,
      eventId,
      sendUpdates: "none"
    });
    deleted += 1;
  }
  return { ok: true, deleted };
};
