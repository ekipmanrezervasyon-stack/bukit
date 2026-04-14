-- BookDeck → Supabase (PostgreSQL)
-- Apps Script backend bu tabloları PostgREST ile okur/yazar.
-- Service role key sadece Apps Script Script Properties içinde tutulmalı (istemciye verilmez).

-- ── Personel (UH) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                text PRIMARY KEY,
  name              text,
  email             text UNIQUE,
  role              text,
  department        text,
  ms_oid            text,
  student_no        text,
  level             text,
  staff_status      text,
  status            text DEFAULT 'active',
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (lower(email));
CREATE INDEX IF NOT EXISTS idx_users_student_no ON users (student_no);

-- ── Öğrenci sheet (Öğrenciler — sıra: 0=no, 2=email tipik) ─
CREATE TABLE IF NOT EXISTS students (
  student_no        text PRIMARY KEY,
  full_name         text,
  email             text,
  department        text,
  level             text,
  raw               jsonb DEFAULT '{}',
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_students_email ON students (lower(email));

-- ── Envanter (IH) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_items (
  id                text PRIMARY KEY,
  name              text,
  type_desc         text,
  status            text,
  assigned_to       text,
  assigned_name     text,
  checked_out_at    timestamptz,
  due_date          timestamptz,
  condition_out     text,
  condition_in      text,
  notes             text,
  email             text,
  barcode_col       text,
  barcode           text,
  photo             text,
  eq_level          text,
  is_selected       boolean DEFAULT false,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_status ON inventory_items (status);
CREATE INDEX IF NOT EXISTS idx_inventory_assigned ON inventory_items (assigned_to);

-- ── Mekanlar (RH) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rooms (
  id                text PRIMARY KEY,
  room_name         text,
  building          text,
  floor             text,
  capacity          int,
  features          text,
  status            text DEFAULT 'available',
  responsible_id    text,
  description       text,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

-- ── Ekipman rezervasyon satırları (RESH — grup başına çok satır) ─
CREATE TABLE IF NOT EXISTS equipment_reservation_lines (
  reservation_group_id text NOT NULL,
  equipment_id         text NOT NULL,
  equipment_name       text,
  equipment_category   text,
  student_id           text,
  student_name         text,
  handover_date        timestamptz,
  return_date          timestamptz,
  status               text,
  approver_email       text,
  purpose              text,
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now(),
  PRIMARY KEY (reservation_group_id, equipment_id)
);

CREATE INDEX IF NOT EXISTS idx_eq_res_student ON equipment_reservation_lines (student_id);
CREATE INDEX IF NOT EXISTS idx_eq_res_status ON equipment_reservation_lines (status);
CREATE INDEX IF NOT EXISTS idx_eq_res_handover ON equipment_reservation_lines (handover_date);

-- ── Stüdyo rezervasyonları (SRSH) ─────────────────────────
CREATE TABLE IF NOT EXISTS studio_reservations (
  id                      text PRIMARY KEY,
  studio_id               text,
  studio_name             text,
  user_id                 text,
  user_name               text,
  start_dt                timestamptz,
  end_dt                  timestamptz,
  purpose                 text,
  pdf_url                 text,
  key_id                  text,
  key_pickup_dt           timestamptz,
  status                  text,
  approved_by             text,
  approved_at             timestamptz,
  rejected_reason         text,
  is_weekend              boolean DEFAULT false,
  notes                   text,
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now(),
  request_type            text,
  studio_usage_form_url   text,
  studio_handover_note    text,
  return_handover_note    text
);

CREATE INDEX IF NOT EXISTS idx_studio_res_user ON studio_reservations (user_id);
CREATE INDEX IF NOT EXISTS idx_studio_res_status ON studio_reservations (status);
CREATE INDEX IF NOT EXISTS idx_studio_res_start ON studio_reservations (start_dt);

-- ── Ödevler (AH) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assignments (
  id                text PRIMARY KEY,
  student_id        text,
  instructor_id     text,
  title             text,
  description       text,
  start_dt          timestamptz,
  deadline          timestamptz,
  equip_id          text,
  location          text,
  status            text,
  approved          boolean DEFAULT false,
  approved_by       text,
  approved_at       timestamptz,
  completed_at      timestamptz,
  notes             text,
  created_by        text,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

-- ── Bildirimler (NH) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id                text PRIMARY KEY,
  type              text,
  recipient_id      text,
  message           text,
  ref_id            text,
  sent_at           timestamptz DEFAULT now(),
  is_read           boolean DEFAULT false,
  channel           text DEFAULT 'in_app'
);

CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications (recipient_id);

-- ── Yasaklılar (BAH) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS bans (
  id                text PRIMARY KEY,
  user_id           text NOT NULL,
  user_name         text,
  ban_level         text,
  reason            text,
  banned_by         text,
  banned_at         timestamptz DEFAULT now(),
  expires_at        timestamptz,
  active            boolean DEFAULT true,
  notes             text
);

CREATE INDEX IF NOT EXISTS idx_bans_user_active ON bans (user_id, active);

-- ── Audit (Geçmiş) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id                text PRIMARY KEY,
  action            text,
  user_id           text,
  target_id         text,
  old_value         text,
  new_value         text,
  timestamp         timestamptz DEFAULT now(),
  note              text
);

CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log (target_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (timestamp DESC);

-- ── CONFIG ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_config (
  key               text PRIMARY KEY,
  value             text
);

-- ── Destek talepleri (TKTH) ────────────────────────────────
CREATE TABLE IF NOT EXISTS tickets (
  ticket_no         text PRIMARY KEY,
  created_at        timestamptz DEFAULT now(),
  name              text,
  email             text,
  phone_ext         text,
  department        text,
  staff_type        text,
  request_type      text,
  use_date          text,
  description       text,
  status            text,
  ticket_type       text,
  start_dt          timestamptz,
  end_dt            timestamptz,
  location          text
);

-- ── Bize Ulaşın (BIZEH) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS bize_contact (
  id                text PRIMARY KEY,
  created_at        timestamptz DEFAULT now(),
  user_id           text,
  user_name         text,
  user_email        text,
  reservation_ref   text,
  message           text,
  status            text,
  admin_reply       text,
  updated_at        timestamptz DEFAULT now()
);

-- ── Birimler / bölüm kodları (sheet yapısı değişkense raw kullanın) ─
CREATE TABLE IF NOT EXISTS units (
  id                text PRIMARY KEY,
  code              text,
  name              text,
  raw               jsonb DEFAULT '{}',
  created_at        timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dept_codes (
  id                text PRIMARY KEY,
  code              text,
  name              text,
  raw               jsonb DEFAULT '{}'
);

-- RLS: Şimdilik tabloları kilitleyin; sadece service_role (Apps Script) kullanılacak.
-- İleride anon key ile doğrudan istemci açarsanız policy ekleyin.

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_reservation_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE bans ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE bize_contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE units ENABLE ROW LEVEL SECURITY;
ALTER TABLE dept_codes ENABLE ROW LEVEL SECURITY;

-- Service role PostgREST ile RLS'yi bypass eder; anon için policy yok = erişim yok.
