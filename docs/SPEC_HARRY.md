# SPEC_HARRY.md — acceptance spec: live status, layout, chat & HTTPS (Virtual Office)

Author: Harry (planner). Date: 2026-10-11 21:45 WIB.
Scope: /root/.hermes/profiles/codi/virtual-office/ (index.html, server.py, https_server.py).
Status: MENGANTIKAN spek lama (SPEC_HARRY.md versi 21:10) — spek lama menuntut hal yang
SUDAH diimplementasi. Bacalah file ini saja; spek lama jangan dipakai.

## 0. Kondisi aktual (dibaca langsung dari kode, bukan asumsi)

Sudah ada dan TERBUKTI jalan (jangan ditulis ulang):

- Runtime lease: server.py:55-84 `detect_working()` membaca `session_turn_leases`
  (read-only sqlite) per profile. Live check 21:42 WIB: `/api/office` melaporkan
  codi/code-analyst/harry/program-developer `working:true, source:"lease"` dengan
  `tasks:[]` (semua kartu kosong) — bukti sinyal lease bekerja tanpa kartu Kanban.
  Ini memenuhi acceptance "lease > kanban" dari spek lama.
- Kanban polling: server.py:90-101 `kanban_cache()` TTL 30 s, refresh non-blocking
  (request tidak pernah menunggu shell `hermes kanban`).
- Chat mention/reply end-to-end: chat.json berisi balasan nyata "Harry: PONG"
  (21:34) dengan `in_reply_to` — jalur @mention → `hermes -p <id> -z` → balasan
  masuk log → frontend poll 3 s terbukti.
- Sertifikat HTTPS: certs/server.crt self-signed, CN=103.154.214.197,
  SAN = IP:103.154.214.197, IP:127.0.0.1, DNS:localhost, berlaku s/d 2036.
- DESK[] dan IDLE[] masing-masing 13 slot (index.html:28-29) — kapasitas 13 sudah ada.

Belum beres / defect nyata (ini isi speknya):

1. Division mention frontend/backend tidak cocok → routing gagal senyap.
2. Penempatan meja bergantung urutan roster, bukan ikatan stabil per profile.
3. Anti-overlap/clip belum diukur (tag, tepi peta, mobil baris avatar).
4. HTTPS tidak pernah berjalan; bentrok port dengan apache (80/443) dan server HTTP (8765).
5. Feed/label basi & fallback demo menampilkan data palsu saat API mati.
6. Chat POST tanpa batas → risiko biaya agent tak terbatas.

## 1. Live status (lease + polling) — sisa defisit, bukan redesain

Target: status yang ditampilkan akurat dan tidak "bohong" dalam kondisi gagal.

- **FR-1.1** `detect_working()` harus menolak lease yang holder PID-nya sudah mati
  (ikuti logika `_holder_dead` dari FINDINGS_DEAN.md §1). Alasan: lease di-hold
  gateway (pid 909) sehingga cek PID saja tidak cukup; tetap wajib ada — tanpa itu
  crash turn meninggalkan "sedang bekerja" palsu ≤300 s (TTL).
- **FR-1.2** `source` di payload hanya boleh `lease` | `kanban` | `idle`; jangan
  pernah mencampur sinyal heuristik `last_activity_at` ke `working:true` tanpa
  label terpisah (Dean §1 rekomendasi: heuristik = "baru saja bekerja", bukan
  "sedang bekerja").
- **FR-1.3** Saat query sqlite gagal (db terkunci/terhapus), profil itu bernilai
  `working:false` + `source:"unknown"` dan payload membawa `degraded:true`;
  jangan ubah kegagalan jadi "semua idle" tanpa jejak (spek lama §1 tetap berlaku
  sebagian: gagal probe ≠ nol pekerja).
- **FR-1.4** Frontend memakai `poll_ms` dari payload (5000) dan menampilkan label
  poll yang benar — teks statis "auto · 20s" pada panel Aktivitas (index.html:23)
  harus sinkron dengan nilai sebenarnya.
- **FR-1.5** Saat `/api/office` gagal, data lama dipertahankan + LED oranye +
  teks "Data lama" (sudah ada). Tapi lihat FR-5.2: fallback demo tidak boleh
  tampil sebagai data nyata.

Acceptance (semua 4 field: metric / instrument / input / window):

- **AC-1.1** Metrik: nol false-positive "working" setelah turn berakhir paksa.
  Instrument: unit test python memanggil `detect_working(now=...)` dengan row lease
  fixture (expired, live+PID mati, live+PID hidup). Input: 3 row fixture di db
  tmp. Window: 1 run deterministik. Lulus = hanya live+PID hidup → true.
- **AC-1.2** Metrik: selama ≥5 menit pemantauan, `generated_at` segar ≤10 s pada
  95% respons (TTL kanban 30 s tidak menunda payload). Instrument: curl loop
  `--max-time 2` tiap 5 s catat usia `generated_at`. Input: server hidup, ≥1
  profile benar-benar running. Window: 5 menit penuh.
- **AC-1.3** Metrik: kartu `running` tanpa lease → tetap tampil `source:"kanban"`
  (bukan lease). Instrument: buka kartu dummy berstatus running di board, ambil
  `/api/office`. Input: 1 kartu fixture. Window: 2 poll.

## 2. Desk binding & pathing

Target: satu profile = satu meja, stabil, dan sampai ke meja tanpa menembus benda.

- **FR-2.1** Ikatan meja bersifat **stabil per profile ID**, bukan `DESK[i % 13]`
  terhadap urutan roster (index.html:45). Saat profile bertambah/hilang, meja lama
  tidak boleh berpindah pemilik. Implementasi yang diterima: peta konstanta
  `{profile_id: slot}` di server (dikirim sebagai `desk_slot` di payload) ATAU
  hash stabil yang sudah diverifikasi tidak berubah untuk 13 profile sekarang.
  Server yang menjadi sumber kebenaran; frontend hanya membaca.
- **FR-2.2** Toleransi "sampai meja": avatar dianggap duduk hanya bila jarak ke
  anchor kursi ≤1% lebar peta; sprite `_sit` diganti setelah tercapai, tidak dari
  cache `atdesk` lama. `window.__charPos` yang sudah basi (flag `atdesk` dari sesi
  sebelumnya) wajib divalidasi ulang terhadap status terbaru tiap render.
- **FR-2.3** Pathing dua titik sekarang (`[x,.56]` → target, index.html:51-53)
  boleh dipertahankan HANYA bila segmennya tidak memotong dinding/furniture.
  Minimal: titik koridor `y=.56` diverifikasi berada di lantai kosong; jika satu
  hari furnitur berubah, jalur gagal → avatar berhenti di titik terakhir yang
  valid dan TIDAK mengklaim duduk (state parkir + tanpa sprite sit).
- **FR-2.4** Semua koordinat tujuan diklamp ke `[0..1]` dan ke dalam bounds peta.

Acceptance:

- **AC-2.1** Metrik: 13/13 profile menempati 13 slot unik (nol duplikat, nol
  kosong) saat semua `working:true`. Instrument: augment payload/debug hook
  `window.__deskMap`, snapshot via headless check atau dump JSON. Input: fixture
  13 profile busy. Window: 1 render.
- **AC-2.2** Metrik: setelah reload 3× berturut-turut dan setelah penghapusan 1
  profile dummy, pasangan profile→slot identik (0 perubahan). Instrument: banding
  `__deskMap` sebelum/sesudah. Input: roster sekarang + 1 profil dummy. Window:
  3 reload.
- **AC-2.3** Metrik: nol segmen path memotong persegi furniture yang terdefinisi
  (daftar rect dinding/kursi/lemari yang sama dengan yang dipakai render).
  Instrument: script python yang mereplay path dari dataset `path` vs daftar rect.
  Input: path hasil 1 siklus penuh idle→duduk→idle. Window: 1 siklus.

## 3. Visual: anti-overlap, anti-clip

- **FR-3.1** Nama tag tidak boleh saling beririsan pada ukuran viewport uji
  (1440×900, 1024×768, 390×844). Strategi yang diterima: lane/stagger per baris,
  lalu fallback label pendek (mis. nama depan) dengan full name di `title`.
  Pengukuran pakai `getBoundingClientRect()` tag-tag, bukan perkiraan mata.
- **FR-3.2** Elemen peta (avatar, tag, properti) tidak boleh keluar/dipotong tepi
  `.map` pada viewport uji — kecuali mode scroll eksplisit yang sudah ada
  (`overflow:auto`). Hitung bounds termasuk lebar tag, bukan hanya pusat avatar.
- **FR-3.3** Jarak pusat antar-avatar ≥4% lebar peta saat idle (IDLE[] sekarang
  memakai titik tetap; pastikan dua profil yang lebih berdekatan pun memenuhi
  batas ini atau pakai jatah slot terdekat yang bebas).
- **FR-3.4** Kontrol UI (`#zoomBtn`, roomlink) tidak menutupi furnitur/floor area
  yang bisa diklik; pindahkan ke toolbar panel bila diperlukan.

Acceptance:

- **AC-3.1** Metrik: 0 irisan rectangle tag pada ketiga viewport × dua skenario
  (13 idle, 13 busy). Instrument: evaluasi JS di browser (CDP/browser tool):
  kumpulkan rect `.nametag`, uji semua pasangan. Input: payload fixture 13 profil.
  Window: 6 kombinasi.
- **AC-3.2** Metrik: 0 elemen yang `rect`-nya melewati batas `.map` (toleransi 0)
  pada viewport yang sama. Instrument: rect check yang sama. Window: sama.
- **AC-3.3** Metrik: 0 pasangan avatar berjarak <4% lebar peta. Instrument: posisi
  `dataset.x/y`. Window: 2 skenario.

## 4. Chat: mention & reply

Kondisi: jalur dasar TERBUKTI (chat.json 21:34). Defect dan hardening yang wajib:

- **FR-4.1 (defect)** Divisi frontend/backend tidak sinkron. server.py:19-24
  DIVISIONS = `koordinasi|engineering|growth|research`; index.html:26 DIV =
  `coord|engineering|growth|research` dan suggest() menyisipkan kunci frontend.
  Akibat: `@coord` / `@Koordinasi` tidak pernah cocok → pesan tersimpan tanpa
  pengiriman, senyap. Satu sumber kebenaran: pakai kunci server
  (`koordinasi|engineering|growth|research`) di frontend, dan fallback ketika
  mention tidak dikenal harus terlihat ("target tidak dikenal", bukan toast
  "terkirim").
- **FR-4.2** Toast/label "Pesan terkirim" hanya boleh muncul bila server memang
  menemukan target. POST tanpa @mention yang valid → balasan `ok:true,
  delivered:false` + toast peringatan.
- **FR-4.3** Antrian pengiriman dibatasi: maks 2 run agent bersamaan per server
  (thread semaphore), antrian maks 20 pesan, pesan >400 karakter dipotong sesuai
  aturan sekarang (server.py:178) dan diberi tanda terpotong. Tanpa batas ini,
  setiap pengunjung halaman bisa memicu run agent tak terbatas (risiko biaya).
- **FR-4.4** `run_profile` timeout 180 s tetapi pesan galat menulis "120 detik"
  (server.py:186) — samakan angkanya dengan nilai timeout sebenarnya.
- **FR-4.5** Riwayat: `fetchChat()` (index.html:66) menimpa `msgs` dari server,
  sehingga pesan lokal localStorage yang belum terkirim hilang dari tampilan.
  Gabungkan: tampilkan pesan server sebagai kanonik, pesan lokal berstatus
  "pending" tetap tampil sampai konfirmasi server.
- **FR-4.6** Balasan agent muncul dalam ≤2× poll (≈6 s) setelah run selesai, dan
  membawa `in_reply_to` yang cocok dengan pesan pemicu (sudah ada — dipertahankan
  dan diuji).

Acceptance:

- **AC-4.1** Metrik: setiap kunci divisi yang ditawarkan autocomplete = kunci yang
  dikenali server (100%). Instrument: unit test memuat daftar DIV/DIVLABEL frontend
  dan DIVISIONS server, bandingkan sebagai set. Input: kedua file. Window: 1 run.
- **AC-4.2** Metrik: mention valid → 1 pesan masuk log + 1 balasan agent dalam
  ≤60 s untuk prompt pendek; mention tak dikenal → 0 subproses `hermes -p` dan
  toast peringatan. Instrument: POST /api/chat + `ps`/log + isi log chat.
  Input: 1 profile aktif, 1 string acak `@zzz`. Window: 1 kasus masing-masing.
- **AC-4.3** Metrik: ≥30 POST dalam 10 s tidak menimbulkan >2 proses `hermes -p`
  bersamaan dan tidak ada POST yang menggantung >5 menit. Instrument: loop curl +
  `pgrep -fc 'hermes -p'`. Input: 30 payload ke target sama. Window: 60 s.

## 5. HTTPS tanpa domain

Fakta: cert self-signed sudah benar (SAN IP 103.154.214.197). Tapi:
`https_server.py` default PORT=8765 = port server HTTP yang sedang dipakai
(pid 2750415), dan 443/80 sudah diduduki apache → layanan HTTPS belum pernah
terbukti hidup.

- **FR-5.1** HTTPS berjalan di port terpisah yang bebas (contoh: 8766 via env
  `PORT`), diverifikasi `ss -ltnp`; jangan rebut 8765 (HTTP aktif) atau 443
  (apache). Pilihan antara (a) https_server.py langsung, (b) reverse-proxy apache
  ke 8765 — keputusan di §8.
- **FR-5.2** Halaman yang disajikan lewat HTTP tidak menampilkan data demo seolah
  nyata (index.html:68 menyuntik 3 kartu demo + recent palsu saat API gagal;
  tampil dengan `ok:false` tetapi tetap terbaca sebagai kenyataan). Wajib: badge
  "MODE DEMO" menonjol atau data demo dihapus sama sekali.
- **FR-5.3** Tanpa domain, browser publik MENAMPILKAN peringatan
  `ERR_CERT_AUTHORITY_INVALID` — itu perilaku yang didokumentasikan, bukan bug.
  Dokumentasikan: (i) jalur perangkat terpercaya = pasang certs/server.crt sebagai
  trusted root di mesin sendiri; (ii) perangkat lain = warning penuh, jangan
  disarankan klik "proceed" untuk data sensitif; (iii) tanpa domain tidak ada
  jalur Let's Encrypt untuk IP murni kecuali CA yang menerbitkan IP-SAN.
- **FR-5.4** Chat/tidak ada kredensial yang dikirim via plaintext bila HTTPS
  sudah aktif: endpoint `/api/chat` di-port HTTP tetap terbuka = risiko. Minimal
  dokumentasikan; idealnya HTTP di-port 8765 di-bind ke 127.0.0.1 bila semua
  akses publik lewat HTTPS.

Acceptance:

- **AC-5.1** Metrik: `curl --cacert certs/server.crt https://<ip>:<port>/api/office`
  → HTTP 200 dan JSON `ok:true`. Instrument: curl dengan CA lokal (bukan -k).
  Input: service hidup. Window: 1 request. CATATAN: uji dari host ini hanya
  valid untuk SAN 127.0.0.1; uji SAN IP utama dari luar/`curl --resolve` dengan
  IP 103.154.214.197.
- **AC-5.2** Metrik: `ss -ltnp` menunjukkan dua listener terpisah (atau satu
  listener HTTPS + proxy) tanpa konflik port. Instrument: ss. Window: sekali.
- **AC-5.3** Metrik: warning browser terekam persis seperti diprediksi (skenario
  tanpa trusted root) dan tanpa warning setelah cert dipasang (skenario terpercaya).
  Instrument: browser tool buka kedua URL, catat pesan error. Window: 2 uji.

## 6. Risiko (peringkat menurut dampak)

1. **Biaya/keamanan chat** (FR-4.3): POST /api/chat tanpa autentik + satu mention =
   satu run agent penuh. Kalau port 8765/8443 terbuka publik, ini yang paling
   mahal. Mitigasi minimal sebelum go-public: batas antrian + rate limit; penuh:
   autentikasi.
2. **Division mismatch** (FR-4.1): defect senyap, user kira pesan terkirim.
3. **Port/HTTPS** (FR-5.1): dua service berebut 8765, apache di 443 — kegagalan
   deploy paling mungkin terjadi di sini.
4. **Lease stale ≤300 s** setelah crash (FR-1.1) — salah tampil ≤5 menit, dapat
   dikurangi tapi tidak nol (desain TTL Hermes).
5. **Desk slot tidak stabil** (FR-2.1) — regresi diam-diam begitu ada profile baru.
6. **Demo fallback menipu** (FR-5.2) — pembaca mengira ada 3 kartu aktif padahal
   API mati.

## 7. Test matrix

| # | Skenario | Data/fixture | Instrumen | AC |
|---|----------|--------------|-----------|-----|
| T1 | Lease hidup vs mati vs expired | 3 row db tmp | unit test python | AC-1.1 |
| T2 | API segar saat polling | server hidup, ≥1 run nyata | curl loop 5 s × 60 | AC-1.2 |
| T3 | Kartu running tanpa lease | 1 kartu fixture | GET /api/office | AC-1.3 |
| T4 | 13 profil sibuk | payload 13 busy | dump `__deskMap` | AC-2.1 |
| T5 | Stabilitas slot | reload ×3 + hapus 1 profil | banding peta | AC-2.2 |
| T6 | Path tidak motong furnitur | 1 siklus idle↔duduk | replay rect python | AC-2.3 |
| T7 | Anti-overlap tag | 13 idle & 13 busy ×3 viewport | CDP rect check | AC-3.1/3.2 |
| T8 | Jarak antar avatar | 2 skenario | posisi dataset | AC-3.3 |
| T9 | Divisi sinkron | kedua file | unit test set | AC-4.1 |
| T10 | Mention valid & tak dikenal | 1 prompt pendek + `@zzz` | POST + ps + log | AC-4.2 |
| T11 | Rate/burst chat | 30 POST/10 s | curl loop + pgrep | AC-4.3 |
| T12 | HTTPS 200 tanpa -k | cert lokal | curl --cacert | AC-5.1 |
| T13 | Dua port bersih | — | ss -ltnp | AC-5.2 |
| T14 | Peringatan browser | 2 URL | browser tool | AC-5.3 |

Urutan eksekusi yang disarankan: T1–T3 (status) → T9–T11 (chat, defect murah &
berisiko biaya) → T7 (visual) → T4–T6 (desk) → T12–T14 (HTTPS terakhir, karena
paling tergantung keputusan port).

## 8. Open decisions (perlu keputusan sebelum implementasi)

1. **Port & jalur HTTPS** — (a) https_server.py di 8766 + trust cert manual
   (cepat, 0 dependensi), (b) apache reverse-proxy 443 → 8765 (perlu audit
   config apache yang sudah jalan, tapi dapat jalur IP-SAN/CA nanti).
   Rekomendasi: (a) untuk bukti kerja sekarang; (b) bila dashboard mau dibuka
   ke publik.
2. **Bind HTTP ke publik atau 127.0.0.1?** Rekomendasi: 127.0.0.1 untuk port
   HTTP begitu HTTPS jalan, karena `/api/chat` belum ber-auth.
3. **Sumber kebenaran desk slot**: konstanta server vs hash stabil.
   Rekomendasi: konstanta server (terbaca, bisa diaudit, tidak berubah saat
   roster berubah).
4. **Demo fallback**: pertahankan dengan badge "MODE DEMO" vs hapus.
   Rekomendasi: hapus — dashboard monitoring tidak boleh pernah menampilkan
   data yang tidak nyata.

Batasan tugas ini: spec-only. Tidak ada kode yang diubah oleh Harry; pelaksanaan
& perbaikan dijalankan program-developer mengurusi file ini.
