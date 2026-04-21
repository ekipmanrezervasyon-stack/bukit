import dotenv from 'dotenv';
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: './.env' });

const argv = process.argv.slice(2);
const args = new Map();
for (let i = 0; i < argv.length; i += 1) {
  const token = String(argv[i] || '');
  if (!token.startsWith('--')) continue;
  const key = token.slice(2);
  const next = argv[i + 1];
  if (!next || String(next).startsWith('--')) {
    args.set(key, 'true');
  } else {
    args.set(key, String(next));
    i += 1;
  }
}

const boolArg = (k, def = false) => {
  if (!args.has(k)) return def;
  const v = String(args.get(k) || '').trim().toLowerCase();
  if (!v) return true;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

const strArg = (k, def = '') => (args.has(k) ? String(args.get(k) || '').trim() : def);

const SRC_CALENDAR_ID = strArg('calendar-id', process.env.GREEN_STUDIO_SOURCE_CALENDAR_ID || '');
const FROM_ISO = strArg('from', new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString());
const TO_ISO = strArg('to', new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString());
const COMMIT = boolArg('commit', false);
const PAGE_LIMIT = Number(strArg('max', '2500')) || 2500;
const DEFAULT_IMPORT_EMAIL = strArg('default-email', process.env.GCAL_IMPORT_DEFAULT_EMAIL || 'studio.import@bilgi.edu.tr');
const IMPORT_PROFILE_ID_ARG = strArg('requester-profile-id', process.env.GCAL_IMPORT_PROFILE_ID || '');
const DRY_RUN = !COMMIT;
const MIN_VALID_YEAR = 2000;
const MAX_EVENT_DURATION_MS = 7 * 24 * 3600 * 1000;

const required = (name, value) => {
  if (!String(value || '').trim()) {
    throw new Error(`Missing required value: ${name}`);
  }
};

const normalize = (v) => String(v ?? '').trim();

const parseServiceAccount = () => {
  const rawJson = normalize(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  if (rawJson) {
    const parsed = JSON.parse(rawJson);
    const email = normalize(parsed.client_email);
    const privateKey = normalize(parsed.private_key).replace(/\\n/g, '\n');
    if (email && privateKey) return { client_email: email, private_key: privateKey };
  }
  const email = normalize(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  const privateKey = normalize(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY).replace(/\\n/g, '\n');
  if (email && privateKey) return { client_email: email, private_key: privateKey };
  throw new Error('Google service account credentials not found (GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_EMAIL/PRIVATE_KEY).');
};

const toIso = (value) => {
  if (!value) return '';
  const ms = new Date(String(value)).getTime();
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString();
};

const compactWhitespace = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const truncate = (s, n) => {
  const t = String(s || '');
  if (t.length <= n) return t;
  return t.slice(0, Math.max(0, n - 1)).trimEnd() + '…';
};

const purposeFromEvent = (ev) => {
  const summary = compactWhitespace(ev.summary || 'GREEN STUDIO BLOCK');
  const desc = compactWhitespace(ev.description || '');
  const marker = ` [gcal:${normalize(ev.id).slice(0, 24)}]`;
  const base = desc ? `${summary} — ${truncate(desc, 70)}` : summary;
  return truncate(base, Math.max(16, 120 - marker.length)) + marker;
};

const requesterFromEvent = (ev) => {
  const attendees = Array.isArray(ev.attendees) ? ev.attendees : [];
  const firstReal = attendees.find((a) => normalize(a?.email) && normalize(a?.email).toLowerCase() !== 'noreply@google.com');
  const organizerEmail = normalize(ev.organizer?.email).toLowerCase();
  const creatorEmail = normalize(ev.creator?.email).toLowerCase();
  const email = normalize((firstReal && firstReal.email) || organizerEmail || creatorEmail || DEFAULT_IMPORT_EMAIL).toLowerCase();
  const name = normalize((firstReal && (firstReal.displayName || firstReal.email)) || ev.organizer?.displayName || ev.creator?.displayName || ev.summary || email || 'Studio Import');
  return { email: email || DEFAULT_IMPORT_EMAIL, name: truncate(name, 180) };
};

const main = async () => {
  required('SUPABASE_URL', process.env.SUPABASE_URL);
  required('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY);
  required('calendar-id or GREEN_STUDIO_SOURCE_CALENDAR_ID', SRC_CALENDAR_ID);

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const studioRow = await sb
    .from('studios')
    .select('id,name,access_level')
    .ilike('name', '%GREEN%')
    .limit(1)
    .maybeSingle();
  if (studioRow.error) throw new Error(`Studios query failed: ${studioRow.error.message}`);
  if (!studioRow.data) throw new Error('GREEN studio row not found in studios table.');

  const greenStudioId = normalize(studioRow.data.id);
  const greenAccess = normalize(studioRow.data.access_level) || 'A';

  const resolveFallbackProfileId = async () => {
    if (IMPORT_PROFILE_ID_ARG) return IMPORT_PROFILE_ID_ARG;
    const pick = await sb
      .from('profiles')
      .select('id,email,role,user_type')
      .in('role', ['super_admin', 'technician', 'staff'])
      .limit(1)
      .maybeSingle();
    if (pick.error) throw new Error(`Fallback profile lookup failed: ${pick.error.message}`);
    if (pick.data && normalize(pick.data.id)) return normalize(pick.data.id);
    const any = await sb.from('profiles').select('id').limit(1).maybeSingle();
    if (any.error) throw new Error(`Any profile lookup failed: ${any.error.message}`);
    if (any.data && normalize(any.data.id)) return normalize(any.data.id);
    throw new Error('No profile row found for requester_profile_id fallback. Set --requester-profile-id explicitly.');
  };

  const fallbackProfileId = await resolveFallbackProfileId();

  const creds = parseServiceAccount();
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/calendar.readonly'] });
  const calendar = google.calendar({ version: 'v3', auth });

  let nextPageToken = undefined;
  const events = [];
  while (events.length < PAGE_LIMIT) {
    const resp = await calendar.events.list({
      calendarId: SRC_CALENDAR_ID,
      timeMin: FROM_ISO,
      timeMax: TO_ISO,
      singleEvents: true,
      showDeleted: false,
      orderBy: 'startTime',
      maxResults: Math.min(2500, PAGE_LIMIT - events.length),
      pageToken: nextPageToken
    });
    const rows = Array.isArray(resp.data.items) ? resp.data.items : [];
    events.push(...rows);
    nextPageToken = resp.data.nextPageToken || undefined;
    if (!nextPageToken) break;
  }

  let skippedMalformed = 0;
  const normalized = events
    .map((ev) => {
      const startRaw = normalize(ev?.start?.dateTime || ev?.start?.date);
      const endRaw = normalize(ev?.end?.dateTime || ev?.end?.date);
      const startAt = toIso(startRaw);
      const endAt = toIso(endRaw);
      if (!startAt || !endAt) return null;
      const startMs = new Date(startAt).getTime();
      const endMs = new Date(endAt).getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        skippedMalformed += 1;
        return null;
      }
      const startYear = new Date(startMs).getUTCFullYear();
      if (startYear < MIN_VALID_YEAR) {
        skippedMalformed += 1;
        return null;
      }
      if ((endMs - startMs) > MAX_EVENT_DURATION_MS) {
        skippedMalformed += 1;
        return null;
      }
      const requester = requesterFromEvent(ev || {});
      return {
        start_at: startAt,
        end_at: endAt,
        requester_email: requester.email,
        requester_name: requester.name,
        requester_profile_id: '',
        purpose: purposeFromEvent(ev || {}),
        studio_id: greenStudioId,
        access_level: greenAccess,
        status: 'approved_by_admin',
        approval_required: false,
        reviewed_by: 'gcal-import',
        reviewed_at: new Date().toISOString()
      };
    })
    .filter(Boolean);

  const uniqueEmails = Array.from(new Set(normalized.map((r) => normalize(r.requester_email).toLowerCase()).filter(Boolean)));
  const emailToProfileId = new Map();
  if (uniqueEmails.length) {
    const prof = await sb
      .from('profiles')
      .select('id,email')
      .in('email', uniqueEmails);
    if (prof.error) throw new Error(`Profiles lookup for event owners failed: ${prof.error.message}`);
    for (const row of (prof.data || [])) {
      const em = normalize(row.email).toLowerCase();
      const pid = normalize(row.id);
      if (em && pid && !emailToProfileId.has(em)) emailToProfileId.set(em, pid);
    }
  }
  normalized.forEach((r) => {
    const em = normalize(r.requester_email).toLowerCase();
    r.requester_profile_id = emailToProfileId.get(em) || fallbackProfileId;
  });

  const existingRes = await sb
    .from('studio_reservations')
    .select('id,start_at,end_at,purpose,studio_id')
    .eq('studio_id', greenStudioId)
    .gte('start_at', FROM_ISO)
    .lte('end_at', TO_ISO)
    .limit(20000);
  if (existingRes.error) throw new Error(`Existing reservations query failed: ${existingRes.error.message}`);

  const existingKeys = new Set(
    (existingRes.data || []).map((r) => `${normalize(r.studio_id)}|${toIso(r.start_at)}|${toIso(r.end_at)}|${compactWhitespace(r.purpose || '')}`)
  );

  const inserts = normalized.filter((r) => {
    const k = `${normalize(r.studio_id)}|${toIso(r.start_at)}|${toIso(r.end_at)}|${compactWhitespace(r.purpose || '')}`;
    return !existingKeys.has(k);
  });

  const report = {
    calendarId: SRC_CALENDAR_ID,
    dryRun: DRY_RUN,
    range: { from: FROM_ISO, to: TO_ISO },
    studio: { id: greenStudioId, name: normalize(studioRow.data.name), access: greenAccess },
    fallbackProfileId,
    fetchedEvents: events.length,
    normalizedEvents: normalized.length,
    skippedMalformed,
    existingInRange: (existingRes.data || []).length,
    toInsert: inserts.length,
    sample: inserts.slice(0, 10).map((x) => ({
      start_at: x.start_at,
      end_at: x.end_at,
      requester_email: x.requester_email,
      requester_name: x.requester_name,
      purpose: x.purpose
    }))
  };

  console.log(JSON.stringify(report, null, 2));

  if (DRY_RUN || inserts.length === 0) return;

  const chunkSize = 200;
  let inserted = 0;
  for (let i = 0; i < inserts.length; i += chunkSize) {
    const chunk = inserts.slice(i, i + chunkSize);
    const ins = await sb.from('studio_reservations').insert(chunk).select('id');
    if (ins.error) {
      throw new Error(`Insert failed at chunk ${i / chunkSize + 1}: ${ins.error.message}`);
    }
    inserted += (ins.data || []).length;
  }

  console.log(JSON.stringify({ ok: true, inserted }, null, 2));
};

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
