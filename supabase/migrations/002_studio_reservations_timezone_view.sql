-- BookDeck — Stüdyo rezervasyonları ve saat dilimi
--
-- Supabase proje bölgesi (ör. Frankfurt) veritabanının “saat dilimini” belirlemez.
-- timestamptz sütunları her zaman tek bir evrensel anı (UTC) saklar; Table Editor ve
-- API yanıtlarında çoğunlukla ISO 8601 + Z (UTC) görmeniz doğrudur — GMT+3 “uygulanmıyor”
-- değil, depolama UTC’dir; gösterim istemci veya SQL ile Europe/Istanbul’a çevrilir.
--
-- Aşağıdaki view, aynı satırları İstanbul duvar saatiyle (timestamp without time zone)
-- okunaklı sütunlar olarak sunar. Metabase / SQL / Table Editor’da bu view’ı kullanın.

CREATE OR REPLACE VIEW public.studio_reservations_istanbul AS
SELECT
  sr.id,
  sr.studio_id,
  sr.studio_name,
  sr.user_id,
  sr.user_name,
  sr.purpose,
  sr.pdf_url,
  sr.key_id,
  sr.status,
  sr.approved_by,
  sr.rejected_reason,
  sr.is_weekend,
  sr.notes,
  sr.request_type,
  sr.studio_usage_form_url,
  sr.studio_handover_note,
  sr.return_handover_note,
  (sr.start_dt        AT TIME ZONE 'Europe/Istanbul') AS start_local,
  (sr.end_dt          AT TIME ZONE 'Europe/Istanbul') AS end_local,
  (sr.key_pickup_dt   AT TIME ZONE 'Europe/Istanbul') AS key_pickup_local,
  (sr.approved_at     AT TIME ZONE 'Europe/Istanbul') AS approved_at_local,
  (sr.created_at      AT TIME ZONE 'Europe/Istanbul') AS created_at_local,
  (sr.updated_at      AT TIME ZONE 'Europe/Istanbul') AS updated_at_local,
  sr.start_dt,
  sr.end_dt,
  sr.key_pickup_dt,
  sr.approved_at,
  sr.created_at,
  sr.updated_at
FROM public.studio_reservations sr;

COMMENT ON VIEW public.studio_reservations_istanbul IS
  'İstanbul duvar saati: *_local sütunları (timestamp without time zone). Orijinal *_dt alanları UTC timestamptz — anlam olarak doğru anı temsil eder.';

-- İsteğe bağlı: bazı iç SQL oturumlarında varsayılan gösterim bölgesi (PostgREST JSON’u genelde yine UTC döndürür).
-- Projenizde hata verirse bu satırı kaldırın veya Dashboard üzerinden timezone ayarlayın.
-- ALTER DATABASE postgres SET TIME ZONE 'Europe/Istanbul';
