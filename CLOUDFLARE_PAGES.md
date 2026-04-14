# Cloudflare Pages Deploy (GAS-siz)

Bu repo Cloudflare Pages'e direkt deploy edilebilir.

## 1) Repo
- Bu klasoru GitHub'a push et.

## 2) Cloudflare Pages Projesi
- Cloudflare Dashboard -> Workers & Pages -> Create -> Pages -> Connect to Git.
- Bu repoyu sec.

## 3) Build Ayarlari
- Framework preset: `None`
- Build command: bos birak (veya `echo "no build"`)
- Build output directory: `/` (repo root)

## 4) Acilacak URL'ler
- User: `https://<pages-domain>/`
- Admin: `https://<pages-domain>/admin`

## 5) API baglantisi
URL'lere API parametresi ekle:
- User: `https://<pages-domain>/?api_base=https://<your-api-domain>`
- Admin: `https://<pages-domain>/admin?api_base=https://<your-api-domain>`

`api_base` parametresi artik kalici cache'e yazilir; eski endpoint'e donmez.

## 6) OTP Notu
Su anda lokal/dev akista OTP kodu ekranda gorunur (mail provider bagli degilse).
Production icin mail provider (Resend/Postmark) eklenmelidir.
