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

## Menjalankan

Prasyarat: Python 3.8+ (stdlib saja, tanpa dependensi pip).

```bash
# cara cepat (tanpa API Hermes — mode demo)
python3 -m http.server 8765 --directory .
# buka http://127.0.0.1:8765/

# mode penuh (API /api/office, /api/chat)
python3 server.py                       # port default 8765
PORT=9000 python3 server.py             # port custom
python3 https_server.py                 # HTTPS (butuh certs/server.crt + key)
```

Endpoint API:

| Endpoint | Isi |
|---|---|
| `GET /api/office` | profiles, tasks aktif, aktivitas terbaru, `generated_at` |
| `GET /api/chat` | log chat + token CSRF |
| `POST /api/chat` | kirim pesan (butuh cookie + header `X-Office-Csrf`) |

## Instal sebagai service (Linux)

```bash
cp deploy/pixeloffice.service /etc/systemd/system/
# edit isi WorkingDirectory/ExecStart ke path repo ini:
$EDITOR /etc/systemd/system/pixeloffice.service
systemctl daemon-reload && systemctl enable --now pixeloffice
```

Service file di `deploy/` memakai path placeholder `__APP_DIR__` — ganti ke
path absolut repo saat instal (lihat komentar di dalam file).

## Struktur

```
index.html          UI utama
server.py           HTTP server + API (stdlib only, port dari env PORT)
https_server.py     varian TLS (baca certs/)
assets/js/          map.js (grid/zona), render.js (room+sprite),
                    animation.js (avatar/label/modal), pathfinding.js (A*),
                    main.js (bootstrap/UI), api.js
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
  (private key TLS) masuk `.gitignore`.
- Data Kanban chat diambil dari API Hermes pada runtime; tanpa Hermes,
  UI jalan dengan data demo.

## Lisensi aset

- `assets/PixelOffice.png` + avatar crop: **CC0** — lihat `assets/LICENSE.txt`.
- `assets/office/` (room + sprite pack): dibuat untuk proyek ini (Gemini AI
  generated base, di-crop per elemen) — lihat `assets/office/manifest.json`.
