-- Seed data for staff onboarding unit dropdowns.
-- Safe to run multiple times (idempotent via ON CONFLICT).

CREATE TABLE IF NOT EXISTS public.units (
  id         text PRIMARY KEY,
  code       text,
  name       text,
  raw        jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

INSERT INTO public.units (id, code, name, raw)
VALUES
  -- Academic units (from provided CSV)
  ('unit_ac_rectorate', 'AC-RECTORATE', 'Rectorate', '{"academic":"Rectorate"}'::jsonb),
  ('unit_ac_communication', 'AC-COMM', 'Faculty of Communication', '{"academic":"Faculty of Communication"}'::jsonb),
  ('unit_ac_law', 'AC-LAW', 'Faculty of Law', '{"academic":"Faculty of Law"}'::jsonb),
  ('unit_ac_business', 'AC-BUS', 'Faculty of Business', '{"academic":"Faculty of Business"}'::jsonb),
  ('unit_ac_architecture', 'AC-ARCH', 'Faculty of Architecture', '{"academic":"Faculty of Architecture"}'::jsonb),
  ('unit_ac_social_sciences_hum', 'AC-SSH', 'Faculty of Social Sciences & Hum.', '{"academic":"Faculty of Social Sciences & Hum."}'::jsonb),
  ('unit_ac_engineering_ns', 'AC-ENS', 'Faculty of Engineering and N.S.', '{"academic":"Faculty of Engineering and N.S."}'::jsonb),
  ('unit_ac_health_sciences', 'AC-HS', 'Faculty of Health Sciences', '{"academic":"Faculty of Health Sciences"}'::jsonb),
  ('unit_ac_applied_sciences', 'AC-AS', 'Faculty of Applied Sciences', '{"academic":"Faculty of Applied Sciences"}'::jsonb),
  ('unit_ac_advanced_vocational_school', 'AC-AVS', 'Advanced Vocational School', '{"academic":"Advanced Vocational School"}'::jsonb),
  ('unit_ac_voc_health', 'AC-VHS', 'VOC. of Health S.', '{"academic":"VOC. of Health S."}'::jsonb),
  ('unit_ac_voc_justice', 'AC-VJ', 'VOC. of Justice', '{"academic":"VOC. of Justice"}'::jsonb),
  ('unit_ac_instute_graduate_programs', 'AC-IGP', 'Instute of Graduate Programs', '{"academic":"Instute of Graduate Programs"}'::jsonb),
  ('unit_ac_european_instute', 'AC-EI', 'European Instute', '{"academic":"European Instute"}'::jsonb),
  ('unit_ac_english_language_progs', 'AC-ELP', 'English Language Progs', '{"academic":"English Language Progs"}'::jsonb),
  ('unit_ac_instute_it_law', 'AC-IITL', 'Instute of IT Law', '{"academic":"Instute of IT Law"}'::jsonb),
  ('unit_ac_school_it', 'AC-SIT', 'School of IT', '{"academic":"School of IT"}'::jsonb),

  -- Administrative units (from provided CSV)
  ('unit_ad_corporate_marketing', 'AD-CM', 'Kurumsal İletişim ve Pazarlama', '{"admin":"Kurumsal İletişim ve Pazarlama"}'::jsonb),
  ('unit_ad_health_culture_sports_student', 'AD-SKS', 'Sağlık, Kültür, Spor ve Öğrenci Destek Hizmetleri', '{"admin":"Sağlık, Kültür, Spor ve Öğrenci Destek Hizmetleri"}'::jsonb),
  ('unit_ad_student_affairs', 'AD-OIDB', 'Öğrenci İşleri Daire Başkanlığı', '{"admin":"Öğrenci İşleri Daire Başkanlığı"}'::jsonb),
  ('unit_ad_energy_museum', 'AD-EM', 'Enerji Müzesi Müdürlüğü', '{"admin":"Enerji Müzesi Müdürlüğü"}'::jsonb),
  ('unit_ad_promotion', 'AD-TANITIM', 'Tanıtım', '{"admin":"Tanıtım"}'::jsonb),
  ('unit_ad_technical_support', 'AD-YTDH', 'Yapı, Teknik ve Destek Hizmetleri', '{"admin":"Yapı, Teknik ve Destek Hizmetleri"}'::jsonb),
  ('unit_ad_personnel', 'AD-PDB', 'Personel Daire Başkanlığı', '{"admin":"Personel Daire Başkanlığı"}'::jsonb),
  ('unit_ad_library_doc', 'AD-KUTUPHANE', 'Kütüphane ve Dokümantasyon', '{"admin":"Kütüphane ve Dokümantasyon"}'::jsonb),
  ('unit_ad_finance', 'AD-MALI', 'Mali İşler', '{"admin":"Mali İşler"}'::jsonb),

  -- Communication departments (from provided CSV)
  ('unit_comm_med', 'COMM-MED', 'MED', '{"communication_department":"MED"}'::jsonb),
  ('unit_comm_adv', 'COMM-ADV', 'ADV', '{"communication_department":"ADV"}'::jsonb),
  ('unit_comm_pub', 'COMM-PUB', 'PUB', '{"communication_department":"PUB"}'::jsonb),
  ('unit_comm_ftv', 'COMM-FTV', 'FTV', '{"communication_department":"FTV"}'::jsonb),
  ('unit_comm_vcd', 'COMM-VCD', 'VCD', '{"communication_department":"VCD"}'::jsonb),
  ('unit_comm_tvrp', 'COMM-TVRP', 'TVRP', '{"communication_department":"TVRP"}'::jsonb),
  ('unit_comm_game', 'COMM-GAME', 'GAME', '{"communication_department":"GAME"}'::jsonb),
  ('unit_comm_cdm', 'COMM-CDM', 'CDM', '{"communication_department":"CDM"}'::jsonb),
  ('unit_comm_pa', 'COMM-PA', 'PA', '{"communication_department":"PA"}'::jsonb),
  ('unit_comm_art', 'COMM-ART', 'ART', '{"communication_department":"ART"}'::jsonb)
ON CONFLICT (id)
DO UPDATE SET
  code = EXCLUDED.code,
  name = EXCLUDED.name,
  raw = EXCLUDED.raw;

