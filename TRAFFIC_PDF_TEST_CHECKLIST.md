# Traffic Checkout PDF Test Checklist

Bu doküman, trafik ekranındaki checkout PDF akışının hızlı çıkışla aynı mantıkta çalıştığını doğrulamak için hazırlanmıştır.

## Hazırlık

1. Admin panelinde `Teslim / İade` ekranını aç.
2. `pickup` tipinde en az bir ekipman kartı olduğundan emin ol.
3. Test kullanıcısının aynı anda birden fazla ekipman çıkışı yapmasına izin veren bir zaman aralığı seç.

## Senaryo 1: Standart Trafik Checkout (Mevcut Kalem)

1. Bir pickup kartında mevcut ekipman satırını seçili bırak.
2. O satırdaki `Ekipman durumu (çıkış)` alanını örn. `Minor Scratch` yap.
3. `ÇIKIŞ YAP & PDF ÜRET` butonuna tıkla.
4. PDF önizleme iframe’inin açıldığını doğrula.

Beklenen sonuç:

1. API isteği `POST /admin/traffic/checkout` olmalı.
2. İstek gövdesinde `id`, `item_ids`, `checkout_condition_map` olmalı.
3. API cevabı `ok: true`, `success: true`, `status: "checked_out"` dönmeli.
4. Üretilen PDF’de ilgili ekipman satırı görünmeli.
5. PDF’de `CONDITION_OUT` kolonu seçilen değerle (`Minor Scratch`) gelmeli.
6. `equipment_items.status` değeri `IN_USE` olmalı.
7. `equipment_reservations.status` değeri `checked_out` olmalı.

## Senaryo 2: Ek Kalemli Trafik Checkout

1. Aynı pickup kartında `Sepete ürün ekle` aramasından müsait bir ekipman ekle.
2. Eklenen kalem için `Ekipman durumu (çıkış)` değerini örn. `Missing Part` yap.
3. Orijinal kalem + ek kalem seçili olacak şekilde checkout işlemini başlat.
4. PDF açıldıktan sonra kart yenilenmeden bir kez daha aynı PDF akışını tetikle (idempotency kontrolü).

Beklenen sonuç:

1. PDF’de hem orijinal hem eklenen kalem görünmeli.
2. Eklenen kalemin `CONDITION_OUT` değeri seçilen değer olmalı.
3. Eklenen kalem için `equipment_items.status = IN_USE` olmalı.
4. Eklenen kalem için `equipment_reservations` tablosunda checkout kaydı oluşmalı.
5. Aynı akışı ikinci kez tetikleyince ek kalem için duplicate rezervasyon satırı artmamalı.

## Hızlı Çıkış Regresyon Kontrolü

1. `Hızlı Çıkış` ekranından normal bir checkout yap.
2. PDF’nin açıldığını ve yazdırılabildiğini doğrula.

Beklenen sonuç:

1. İstek `POST /admin/quick-checkout` endpoint’ine gitmeli.
2. Hızlı çıkış PDF içeriği ve akışı önceki davranışla aynı kalmalı.
3. Trafik checkout için yapılan değişiklikler hızlı çıkışı etkilememeli.

## Notlar

1. `PDF / form` butonu da aynı `POST /admin/traffic/checkout` endpoint’ini kullanır.
2. Bu testte özellikle `pickup` kartları üzerinden checkout doğrulaması önerilir.
