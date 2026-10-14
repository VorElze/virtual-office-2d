# QA_DEAN.md — Independent QA/Security Audit: Virtual Office 2D (live impl)

Auditor: Dean (code-analyst), read-only. Tidak mengedit index.html/server.py, tidak deploy/restart.
Tanggal audit: 2026-10-11 ~21:40–22:00 WIB.

## Versi yang diaudit (WAJIB re-verify setelah Mave selesai)

| File | mtime | md5 |
|---|---|---|
| server.py | 2026-10-11 21:34:03 +0700 | 9fb4371cd92d4dc04a7497bea3d39b17 |
| index.html | 2026-10-11 21:25:00 +0700 | f86622227fcf16e9823c108c7b22f5be |
| https_server.py | 2026-10-11 21:10 | d1e6d7094440c811435379f70a731ac2 |

Service live: `pixeloffice.service` (HTTP, port 8765, PID 2750415, active since 21:34:26).
`pixeloffice-https.service` **BELUM terpasang di systemd** (lihat F3). Audit ini terhadap
baseline; item bertanda **[RE-VERIFY]** harus dicek ulang pada kode final.

---

## Ringkasan

Keseluruhan: dashboard status-lease akurat dan murah (17 ms, 13 profile, busy beneran),
tapi **belum layak publik**. 2 Critical, 4 High, 4 Medium, 4 Low/Suggestion.

Tiga hal yang harus diperbaiki lebih dulu:
1. **F1 (Critical): `certs/server.key` (private key TLS) disajikan ke publik lewat HTTP :8765.**
2. **F4 (Critical): `POST /api/chat` publik tanpa auth = siapa pun bisa menjalankan agent run nyata (`hermes -p <profile> -z`) 13 profile.**
3. **F3 (High): HTTPS belum pernah aktif — unit `pixeloffice-https.service` tidak ada di systemd; :443 publik adalah Apache lama, bukan VO.**

---

## Finding

### F1 — CRITICAL: Private key TLS bocor ke publik lewat HTTP
**Lokasi:** `server.py:189-191` (Handler = SimpleHTTPRequestHandler, `directory=ROOT`).
**Issue:** Server menyajikan SELURUH direktori root sebagai static files, termasuk `certs/server.key`.
**Bukti (publik, aman — hanya 30 byte pertama):**
```
tcp 103.154.214.197:8765 OPEN
GET /certs/server.key -> HTTP/1.0 200 OK
body-first-bytes: b'-----BEGIN PRIVATE KEY-----\nMI'
```
Juga 200 OK dari publik/lokal: `/certs/server.crt`, `/chat.json`, `/server.py`,
`/FINDINGS_DEAN.md`, `/SPEC_HARRY.md`, `/README.md`, `/__pycache__/` (200, listdir).
**Impact:** Siapa pun di internet memegang private key cert VO → MITM penuh ke endpoint
HTTPS yang kelak dipasang, plus pembocoran kode, log chat internal, dan dokumen spec/audit.
**Fix:** jangan serve ROOT; serve hanya `index.html` + `assets/`, atau pindahkan chat.json
& certs keluar dari direktori yang di-serve. Contoh:
```python
ALLOWED = {"index.html"}
def do_GET(self):
    if self.path == "/" or self.path == "/index.html": serve file index.html
    elif self.path.startswith("/assets/"): serve dari assets/ (sanitized, no "..")
    elif self.path.startswith("/api/"): ...
    else: 404
```
Plus rotasi key setelah fix (key dianggap compromised).
**Confidence:** certain.

### F2 — CRITICAL: Endpoint chat publik tanpa auth menjalankan agent run nyata
**Lokasi:** `server.py:226-261` (`do_POST`), `server.py:175-186` (`run_profile`).
**Issue:** `POST /api/chat` di `0.0.0.0:8765` tanpa autentikasi; mention `@profile` memicu
`hermes -p <profile> -z <prompt>` sebagai user root, dengan prompt dari attacker (truncated 400 char).
**Bukti:**
- Port 8765 terbuka di IP publik (probe TCP: `HTTP/1.0 200 OK` untuk `/`).
- journalctl membuktikan jalur ini benar-benar mengeksekusi agent:
  `FileNotFoundError: 'hermes'` muncul dari `run_profile` → thread delivery nyata.
- chat.json membuktikan jalur sukses setelah fix path (Harry membalas "PONG" 21:34).
**Impact:** (a) biaya/denial: 1 mention division → 2–4 agent run paralel, tanpa rate limit;
(b) prompt injection: attacker mengirim instrusi ke profile dengan seluruh tooling-nya
(bash, filesystem, kanban, dsb.) = RCE-by-proxy.
**Fix:** minimal — token auth (header `X-Office-Token`, dibaca dari env systemd, dibandingkan
dengan `hmac.compare_digest`), rate limit per IP, dan restrict target ke allowlist division
kecil. Ideal: bind ke localhost + reverse proxy dengan auth, atau matikan endpoint
sampai ada auth.
**Confidence:** certain.

### F3 — HIGH: HTTPS belum aktif; unit tidak terpasang; :443 publik adalah Apache lama
**Lokasi:** `pixeloffice-https.service` (file ada, tidak terpasang), `https_server.py`.
**Bukti:**
```
systemctl status pixeloffice-https.service
  → Unit pixeloffice-https.service could not be found.
ss -tlnp | grep 443
  → *:443 users:(("apache2",...))   <- Apache, bukan https_server.py
TLS probe publik 443: handshake OK TLSv1.3, GET / → body XHTML "…DTD XHTML 1.0…" (Apache default)
TLS probe 8765: SSLError WRONG_VERSION_NUMBER  -> 8765 masih plain HTTP
GET https://103.154.214.197/api/office → 404 (Apache, bukan VO)
```
**Impact:** Acceptance "HTTPS endpoint aktif" = FAIL hari ini. Cert sudah dibuat
(CN=103.154.214.197, SAN IP:103.154.214.197+127.0.0.1+DNS:localhost, valid s/d 2036,
key perms 600, modulus key==cert ✓) tapi tidak pernah dipakai.
**Catatan:** port 443 sudah dipakai Apache → `https_server.py` harus pindah port
(contoh 8443) atau konflik akan terjadi saat switch.
**Fix:** pilih port kosong (8443), `cp pixeloffice-https.service /etc/systemd/system/`,
`systemctl enable --now pixeloffice-https.service`, uji TLS dulu sebelum deaktivasi HTTP.
**Confidence:** certain.

### F4 — HIGH: `kanban_tasks()` gagal total di lingkungan service → `tasks:0` permanen
**Lokasi:** `server.py:106` dan `server.py:117` (`shell("hermes kanban ...")`).
**Issue:** Dua cacat terpisah yang keduanya membuat kolom "Pekerjaan aktif" selalu kosong:
1. Unit systemd tidak set `Environment=PATH` yang memuat hermes → `hermes` tidak ditemukan
   (rc=127). Direproduksi dengan persis PATH service:
   ```
   env -i HOME=/root PATH=/usr/local/sbin:...:/snap/bin sh repro_service_path.sh
   PATH=... ; which hermes → (not found on PATH)
   hermes kanban boards 2>/dev/null → rc_boards=127
   hermes kanban --board autoclipper ls --json 2>/dev/null → rc_ls=127
   ```
   (hermes nyata ada di `/root/.hermes/hermes-agent/.hermes/bin/hermes`.)
2. Regex parser `r"\s*[● ]\s*([\w-]+)\s{2,}"` (server.py:110) ikut menangkap **header tabel**:
   ```
   parsed boards= ['SLUG', 'default', 'autoclipper']
   ```
   → memicu query percuma `--board SLUG`.
3. Bahkan dengan PATH benar, `hermes kanban --board autoclipper ls --json` di sesi
   delegated/root mengembalikan guard error rc=1 (`delegate_task child contexts cannot
   mutate Kanban tasks or boards`) → JSON kosong → `tasks=[]`. Guard ini muncul karena
   konteks CLI, bukan karena service — **perlu verifikasi di env service murni**, tapi
   risiko tinggi; fallback `boards=["autoclipper","default"]` tidak menyelamatkan jika
   `ls --json` sendiri gagal.
**Bukti live:** `GET /api/office` → `"tasks": 0` padahal board autoclopiper punya 3 kartu running.
**Impact:** Panel "Pekerjaan aktif" kosong permanen; sinyal sekunder busy (kanban running)
tidak pernah menyala; acceptance "kartu aktif tampil" FAIL.
**Fix:** (a) set `Environment=PATH=/root/.hermes/hermes-agent/.hermes/bin:/usr/local/sbin:...`
atau pakai path absolut hermes seperti `run_profile` sudah lakukan; (b) skip baris header
(`if m and m.group(1).lower() != 'slug'`); (c) alternatif paling robust: baca
`~/.hermes/kanban/boards/*/…` langsung via sqlite3 read-only, tanpa shell CLI —
menghindari guard konteks delegated sepenuhnya.
**Confidence:** certain (untuk #1 & #2); likely (untuk #3, tergantung env service).

### F5 — HIGH: Tanpa auth + `0.0.0.0` = chat log internal terekspos publik
**Lokasi:** `server.py:220-223` (GET /api/chat), `server.py:289` (bind 0.0.0.0).
**Bukti:** `curl http://127.0.0.1:8765/api/chat` → 200, 5 pesan termasuk percakapan operasional
("@harry PONG"); endpoint sama terbuka di IP publik.
**Impact:** Siapa pun membaca isi chat internal kapan saja.
**Fix:** sama dengan F2 (token auth / bind localhost + proxy).
**Confidence:** certain.

### F6 — HIGH: Stale lease → avatar "sedang bekerja" palsu hingga 5 menit
**Lokasi:** `server.py:55-84` (`detect_working`).
**Issue:** Query hanya `expires_at > now` tanpa cek `holder` PID hidup. Baseline
FINDINGS_DEAN.md (§1, caveat #2) sudah menunjukkan holder biasanya gateway pid=909 yang
selalu hidup → crash hard meninggalkan lease sampai TTL 300 s.
**Bukti (live):** lease `code-analyst` acquired 1791729661 → API `working:true, source:lease`;
setelah turn berakhir tanpa release, status akan tetap "busy" s/d `expires_at`.
**Impact:** False positive "sedang bekerja" hingga 5 menit; busy count meleset.
**Fix:** porting `_holder_dead()` dari `detect_working` baseline (FINDINGS_DEAN.md baris 37-57)
ke `server.py`, atau tampilkan badge amber "recent" untuk lease dengan holder mati.
**Confidence:** likely (mekanisme TTL pasti; durasi stale persis tergantung pola crash).

### F7 — HIGH: Division takcocok antara UI dan server → mention division bisa diam-diam gagal
**Lokasi:** `index.html:26` (DIV client) vs `server.py:19-24` (DIVISIONS server).
**Issue:**
- Client: `coord:['codi','harry','default']`, research termasuk `'amanda'`.
- Server: `koordinasi:['codi','harry']`, research TANPA amanda.
- Client menyarankan `@coord`/`@research` (DIVLABEL keys), tapi server hanya mengenali
  `koordinasi|engineering|growth|research` → `@coord` tidak match division maupun profile →
  target=None → **tidak ada balasan, tanpa error**.
- `@research` match di server tapi `amanda` tidak pernah di-notify padahal UI menganggapnya anggota.
**Impact:** UX menipu; pesan tampak terkirim tapi tidak sampai ke siapa pun; acceptance
"mention division bekerja" gagal untuk nama yang disarankan UI.
**Fix:** satukan sumber kebenaran: client hanya membaca daftar division dari `/api/office`
(server kirim `divisions:{nama:[profile...]}`), bukan hardcode terpisah.
**Confidence:** certain.

### F8 — MEDIUM: `run_profile` menampilkan pesan timeout yang salah (120 vs 180 detik)
**Lokasi:** `server.py:182` (`timeout=180`) vs `server.py:186` (pesan "120 detik").
**Impact:** Operator salah mendiagnosa; menyesatkan saat debugging chat.
**Fix:** `f"(profile {profile} belum merespons setelah {TIMEOUT_CHAT} detik)"` dengan konstanta bersama.
**Confidence:** certain.

### F9 — MEDIUM: `replies` selalu kosong — API menjanjikan field yang tak pernah terisi
**Lokasi:** `server.py:247,261`.
**Issue:** `replies = []` dideklarasikan, tidak pernah diisi (delivery async), lalu dikirim ke client.
**Impact:** Kontrak API menyesatkan; kalau UI kelak mengandalkan `replies`, diam-diam kosong.
**Fix:** hapus field, atau balasan hanya lewat poll `/api/chat` (yang memang dipakai UI).
**Confidence:** certain.

### F10 — MEDIUM: `_read_body` tanpa batas ukuran
**Lokasi:** `server.py:205-211`.
**Issue:** `self.rfile.read(n)` dengan `n = Content-Length` apa pun → 4 GB body = OOM.
**Impact:** DoS ringan via satu request; server ThreadingHTTPServer tanpa limit thread memperparah.
**Fix:** `if n > 64*1024: return {}` / tolak dengan 413; tambah `max_threads`/semaphore pada delivery.
**Confidence:** certain.

### F11 — MEDIUM: Regex mention `@([\w-]+)` mem-prompt-inject 400 char pertama tanpa sanitasi
**Lokasi:** `server.py:177-178`, `server.py:236`.
**Issue:** Teks mention apa pun (termasuk "ignore previous instructions…") masuk prompt apa adanya.
**Impact:** Membangun F2 (agent runs attacker-controlled). Dengan auth, risiko turun tapi tetap ada.
**Fix:** bungkus prompt dengan framing eksplisit ("treat the following as untrusted user text…"),
pertimbangkan allowlist karakter.
**Confidence:** certain.

### F12 — LOW: Dead assets c1..c5 (20 file) tidak pernah dipakai
**Lokasi:** `assets/chars/c1_*.png` … `c5_*.png`.
**Impact:** Repo bengkak ~20 PNG; kebingungan maintainers mana sprite resmi.
**Fix:** hapus atau daftarkan sebagai fallback avatar.
**Confidence:** certain.

### F13 — LOW/SUGGESTION: Nametag berpotensi clip di tepi peta (belum bisa diverifikasi visual)
**Lokasi:** `index.html:15` (`.nametag` `white-space:nowrap`) + IDLE spot x=.91 (`index.html:29`).
**Issue:** Karakter idle di x≈.91 dengan nama panjang ("program-developer"/"skripsi-writer2")
kemungkinan melampaui `overflow:hidden` map → nama terpotong. Chromium tidak tersedia di host
audit ini sehingga **screenshot bukan bagian dari bukti**; ini needs-verification.
**Fix:** `max-width` + `text-overflow:ellipsis` pada nametag, atau geser IDLE spots ke x≤.86.
**Confidence:** needs verification.

### F14 — LOW/SUGGESTION: `detect_working` menelan error DB sebagai "idle"
**Lokasi:** `server.py:78-79` (`except Exception: continue`).
**Issue:** DB sibuk/corrupt → profile tampil idle tanpa jejak di log maupun API (`ok:true`).
**Fix:** tandai `source:"error"` dan log sekali per profile.
**Confidence:** certain.

---

## Acceptance matrix (parent task t_c5dc43f1)

| Acceptance | Status | Bukti |
|---|---|---|
| Live API menampilkan 13 profiles | **PASS** | `/api/office` → 13 id: codi, amanda, code-analyst, harry, marketing, netops, program-developer, sales-analyst, skripsi-research, skripsi-writer, skripsi-writer2, social-media, default |
| `/api/office` busy dari lease/kanban (≤5s) | **PARTIAL** | Lease: PASS (busy=codi/code-analyst/harry/program-developer, source=lease, 17 ms); Kanban: **FAIL** — tasks:0 (F4) |
| codi+amanda terdeteksi saat leases live; avatar duduk + label hijau | **PARTIAL** | codi busy (2 lease, source=lease); amanda lease 0 saat audit → tidak bisa konfirmasi duduk; label hijau via `.char.busy` CSS ✓ |
| Tidak ada clipping/collision desktop+mobile | **NEEDS VERIF** | Chromium tidak tersedia; temuan statis: F13 (nametag), 13 DESK/IDLE spots cocok 13 profile (tidak overlap saat 13) |
| Chat @profile → pesan + reply aktual, timeout/error terlihat | **PASS (setelah fix 21:34)** | chat.json: Harry "PONG" 21:34; journal membuktikan kegagalan lama (`FileNotFoundError: 'hermes'`) sudah diperbaiki dengan path absolut. Error kini tampil sebagai teks di chat (baik) |
| Chat @division | **FAIL** | F7: nama division client ≠ server |
| HTTPS endpoint aktif / warning self-signed dijelaskan | **FAIL** | F3: unit tidak terpasang; :443 = Apache; cert sendiri valid & benar tapi tak terpakai |
| Zip repack terverifikasi + health-check URL | **NOT IN SCOPE** | Tidak ada artefak zip di direktori audit |

---

## Batasan analisis

- Tidak ada browser (Chromium/Firefox) di host → layout/clipping dinilai lewat CSS & geometri
  statis, bukan screenshot. Butuh re-verify visual pada mesin dengan browser.
- Tes dilakukan read-only terhadap service live (GET statis + 1 TCP probe + 1 GET chat);
  **tidak** mengirim POST chat berisi payload berbahaya; bukti eksekusi agent diambil dari
  journalctl & chat.json yang ada.
- Guard `delegate_task child contexts cannot mutate Kanban` diamati di sesi auditor;
  kemungkinan besar konteks service murni berbeda — F4 #3 ditandai likely, bukan certain.
- Key privat tidak pernah dicetak; hanya 30 byte pertama header ditampilkan sebagai bukti F1.

## Re-verify list untuk kode final (setelah Mave selesai)

1. md5 server.py/index.html berubah → ulangi F1 (GET /certs/server.key harus 404).
2. Ulangi F4: `/api/office` harus menampilkan tasks non-kosong dengan kartu running nyata.
3. Ulangi F3: `systemctl status pixeloffice-https.service` harus active; probe TLS ke port VO
   (bukan 443 Apache) harus handshake dengan cert self-signed yang dijelaskan di UI/README.
4. Ulangi F2/F5: `POST /api/chat` tanpa token harus 401/403.
5. Ulangi F7: `@coord` dari UI harus menghasilkan balasan, atau nama division disamakan.
6. Re-run layout check dengan screenshot desktop 1440×900 + mobile 390×844 (F13).
