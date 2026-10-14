# Virtual Office 2D — PixelOffice (Hermes)

Dashboard kantor virtual 2D: denah pixel 4 ruangan (Main Office, Cafeteria,
Lounge, Meeting Room), 11 avatar worker di kursi, panel Kanban live, chat
dengan mention `@profile` / `@division`, dan auto-reply dari worker Hermes.

## Fitur

- Grid dunia 33×17 (1056×544 px) — room PNG digambar native 1x, pixel-crisp.
- Avatar: 11 profil × 4 pose (idle/sit/walk), label memakai **alias**
  (mis. `mave`, bukan `program-developer`); klik avatar → drawer profile.
- Klik **whiteboard** Meeting Room → modal Kanban (status ready/running/
  blocked/done, auto-refresh 5s).
- Chat: routing mention hemat — `@alias` hanya men-target profil yang
  disebut; tanpa mention = broadcast; target eksplisit & `@division`
  tetap bekerja.
- Panel "Pekerjaan aktif" + "Aktivitas terbaru" dari API live Hermes,
  dengan **fallback demo** bila API offline.
- Strict static whitelist: hanya `/`, `/index.html`, `/assets/*` yang
  disajikan — root repo, `*.py`, `certs/`, chat log TIDAK bisa diakses HTTP.

## Keamanan (VO-OFFICE-R1, live sejak 13 Okt 2026)

**Login wajib.** Autentikasi aktif di semua port — termasuk 8765 polos,
bukan hanya di belakang HTTPS. Sebelum ada akun, instance tampil sebagai
halaman **registrasi akun pertama**; begitu satu user terdaftar, registrasi
ditutup (`403 register_closed`) sehingga tidak ada orang lain yang bisa
menguasai instance lewat race registrasi.

Kontrak API auth (semua path **relatif**, tanpa leading slash — tetap benar
di belakang prefix `/office` maupun port polos):

| Endpoint | Akses | Isi |
|---|---|---|
| `GET  api/auth/status` | public | `{auth_required, authenticated, user, mode}` |
| `POST api/auth/register` | 200 hanya bila belum ada user | buat akun pertama / pakai `invite` |
| `POST api/auth/login` | 200 + `Set-Cookie` | session token |
| `POST api/auth/logout` | 200 | hapus cookie |

Detail hardening:

- **Password**: PBKDF2-HMAC-SHA256, 200.000 iterasi (OWASP 2023 minimum),
  salt acak per user, min 8 / maks 256 karakter. Stdlib saja, tanpa dependensi.
- **Session**: token acak, cookie `office_session` **HttpOnly + SameSite=Lax**,
  TTL 12 jam (`AUTH_SESSION_TTL_S`). HttpOnly → JS tidak bisa membacanya;
  frontend cukup memantau `401` dari endpoint data.
- **CSRF**: cookie `office_csrf` **SameSite=Strict** + cek header
  `X-Office-Csrf` untuk semua `POST /api/chat`.
- **Rate limit login**: 5 percobaan gagal / 5 menit per IP → `429`
  sementara (anti brute-force).
- **Invite** (`?invite=<token>`): link registrasi sekali pakai bila ingin
  mengundang user baru setelah akun pertama dibuat. Token divalidasi server,
  ditandai terpakai, lalu dihapus dari URL/address bar oleh `auth.js`.
- **Runtime auth tidak di-commit**: `users.json` (hash + salt),
  `sessions.json`, `invite.json`, `.auth_enabled` masuk `.gitignore`.

## HTTPS

`https_server.py` memuat rantai sertifikat dari `certs/server.crt` +
`certs/server.key` (buat sendiri — **jangan commit key**):

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/CN=<host-anda>"
```

Implementasi TLS memakai `TLSThreadedHTTPServer`: handshake dijalankan di
**thread pekerja**, bukan di loop `accept`, dengan `request_queue_size=128`
dan `handshake_timeout=10`. Ini menambal bug di mana satu koneksi klien yang
stall (mis. browser HP mati di tengah handshake) memblokir `accept` seluruhnya
→ backlog penuh → 503 padahal service "active" (terbukti live 13 Okt 20:05 WIB).

## Menjalankan

Prasyarat: Python 3.8+ (stdlib saja, tanpa dependensi pip).

```bash
# cara cepat (tanpa API Hermes — mode demo)
python3 -m http.server 8765 --directory .
# buka http://127.0.0.1:8765/  (tanpa auth — hanya untuk lihat UI)

# mode penuh (auth + API /api/office, /api/chat)
python3 server.py                       # port default 8765
PORT=9000 python3 server.py             # port custom
python3 https_server.py                 # HTTPS (butuh certs/server.crt + key)
OFFICE_PREFIX=/office python3 https_server.py   # di belakang reverse proxy
```

Endpoint data:

| Endpoint | Isi |
|---|---|
| `GET /api/office` | profiles, tasks aktif, aktivitas terbaru, `generated_at` |
| `GET /api/chat` | log chat + token CSRF |
| `POST /api/chat` | kirim pesan (butuh session + header `X-Office-Csrf`) |

### Di belakang reverse proxy (Apache)

Backend melayani prefix `/office` (env `OFFICE_PREFIX=/office`) supaya aset
dan API relatif tetap benar di belakang `ProxyPass`:

```apache
ProxyPass        /office https://127.0.0.1:8765/office
ProxyPassReverse /office https://127.0.0.1:8765/office
```

Port 8765 tetap bisa diakses tanpa prefix (backward-compat).

## Instal sebagai service (Linux)

```bash
cp deploy/pixeloffice.service /etc/systemd/system/
# edit isi WorkingDirectory/ExecStart ke path repo ini, lalu tambah:
#   Environment=OFFICE_PREFIX=/office   (hanya bila di belakang proxy)
systemctl daemon-reload && systemctl enable --now pixeloffice
```

Service file di `deploy/` memakai path placeholder `__APP_DIR__` — ganti ke
path absolut repo saat instal (lihat komentar di dalam file).

## Struktur

```
index.html          UI utama + overlay auth (modal login/registrasi)
server.py           HTTP server + API + auth (stdlib only, port dari env PORT)
https_server.py     varian TLS (handshake di worker thread)
assets/js/          map.js (grid/zona), render.js (room+sprite),
                    animation.js (avatar/label/modal), pathfinding.js (A*),
                    main.js (bootstrap/UI), api.js, auth.js (gate login)
assets/css/         office.css
assets/office/      aset hasil regen: 4 room PNG + 34 sprite (+ @2x), manifest.json
assets/chars/       11 profil × 4 pose
docs/               spek Harry, QA & findings Dean (arsip proses)
deploy/             systemd unit template
```

## Portabilitas

- Path semuanya relatif terhadap lokasi `server.py` (ROOT) — pindah folder /
  clone ke server lain tanpa edit kode.
- Tidak ada secret yang di-commit: `chat.json`, `chat_audit.log`, `certs/`
  (private key TLS), `users.json`, `sessions.json`, `invite.json`,
  `.auth_enabled` masuk `.gitignore`.
- Data Kanban chat diambil dari API Hermes pada runtime; tanpa Hermes,
  UI jalan dengan data demo.

## Lisensi aset

- `assets/PixelOffice.png` + avatar crop: **CC0** — lihat `assets/LICENSE.txt`.
- `assets/office/` (room + sprite pack): dibuat untuk proyek ini (Gemini AI
  generated base, di-crop per elemen) — lihat `assets/office/manifest.json`.
