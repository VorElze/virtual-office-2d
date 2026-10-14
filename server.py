#!/usr/bin/env python3
"""PixelOffice Virtual Office server.

Serves the static dashboard plus:
  GET  /api/office  — live profile snapshot per SPEC_HARRY.md (4s cache),
                      busy from session_turn_leases (authoritative, per
                      FINDINGS_DEAN.md) + recent session activity (labeled).
  GET  /api/chat    — transcript + outbox states (queued/running/replied/failed).
  POST /api/chat    — structured {target_profile, text, client_message_id},
                      validated against the roster, bounded queue, per-target
                      serialization, CSRF/origin check, rate limit, audit log.

Chat replies run `hermes -p <profile> -z <prompt>` as argv (no shell).
"""
import base64
import hashlib
import json
import hmac
import os
import queue
import re
import secrets
import sqlite3
import subprocess
import threading
import time
import urllib.parse
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROFILES_DIR = Path("/root/.hermes/profiles")
KANBAN_BOARDS_DIR = Path("/root/.hermes/kanban/boards")

# ---------------------------------------------------------------------------
# Roster / display names
# ---------------------------------------------------------------------------
# Single source of truth for division membership (QA_DEAN F7): the payload
# publishes this map and the frontend renders from it — no client-side copy.
# Amanda = office manager -> koordinasi; 'default' (gateway profile) is not a
# worker and is intentionally absent from every division.
DIVISIONS = {
    "koordinasi": ["codi", "harry", "amanda"],
    "engineering": ["program-developer", "code-analyst", "netops"],
    "growth": ["marketing", "social-media", "sales-analyst"],
    "creative": ["graphic-designer"],
}
ALIAS = {
    "codi": "Codi", "harry": "Harry", "program-developer": "Mave",
    "code-analyst": "Dean", "netops": "Rick", "marketing": "Rendra",
    "social-media": "Laras", "sales-analyst": "Bima",
    "graphic-designer": "Reno", "amanda": "Amanda", "default": "Orion",
}
# Frozen desk-slot assignment: slot index permanently bound to profile ID.
# Reordering the roster must NOT change seats (SPEC_HARRY §2).
# 12 Okt 2026: profil skripsi (Nadia/Danu/Raka) dihapus owner; slot lama 8/9/10
# dilepas — Reno (graphic-designer) menghuni slot 8. Slot 9/10 sengaja kosong
# (tak berpenghuni) agar indeks profil lain TIDAK bergeser.
FROZEN_ORDER = (
    "codi", "harry", "program-developer", "code-analyst", "netops",
    "marketing", "social-media", "sales-analyst", "graphic-designer",
    "", "", "amanda", "default",
)
DESK_SLOT = {pid: i for i, pid in enumerate(FROZEN_ORDER) if pid}
# 11 profil terisi; slot 9 & 10 sengaja kosong (lihat catatan FROZEN_ORDER).
assert len(DESK_SLOT) == 11 and len(set(DESK_SLOT.values())) == 11
assert len(FROZEN_ORDER) == 13  # 13 kursi total, 2 tanpa penghuni

REFRESH_SECONDS = 5          # frontend poll (SPEC FR-1.4: poll_ms payload = 5000)
SNAPSHOT_TTL = 4             # server-side snapshot cache (SPEC §1)
SESSION_WINDOW = 600         # "session activity within 10 min" (SPEC §1)
LEASE_SOURCES = ("task_run",)
CHAT_MAX_TEXT = 1000         # hard reject limit
CHAT_TRUNCATE_AT = 400       # FR-4.3: longer text truncated, marked
CHAT_QUEUE_MAX = 20          # FR-4.3: bounded pending queue
CHAT_WORKERS = 2             # FR-4.3: max 2 concurrent agent runs
CHAT_RATE_PER_MIN = 10       # per-client POSTs per minute
CHAT_TIMEOUT_S = int(os.environ.get("CHAT_TIMEOUT_S", "180"))
HERMES_BIN = os.environ.get("HERMES_BIN", "/root/.hermes/hermes-agent/.hermes/bin/hermes")
OFFICE_TOKEN = os.environ.get("OFFICE_TOKEN", "")  # optional extra POST auth

# ---------------------------------------------------------------------------
# VO-OFFICE-R1: prefix mount (Apache reverse proxy -> 127.0.0.1:8765)
# ---------------------------------------------------------------------------
# Backend melayani prefix /office (strip) supaya aset & API relatif tetap jalan
# di belakang ProxyPass /office http://127.0.0.1:8765/. Port 8765 tetap jalan
# tanpa prefix untuk backward-compat -> nilai "" = tanpa prefix.
# Set pixeloffice.service: Environment=OFFICE_PREFIX=/office
MOUNT_PREFIX = os.environ.get("OFFICE_PREFIX", "").rstrip("/")

# ---------------------------------------------------------------------------
# VO-OFFICE-R1: auth (registrasi pertama + login wajib)
# ---------------------------------------------------------------------------
# Storage : users.json  (password hash pbkdf2_hmac, stdlib saja)
#           sessions.json (token acak -> {user, expires_at})
# Flag     : .auth_enabled  (dipakai untuk port 8765 backward-compat; file
#            pertama kali dibuat saat registrasi pertama berhasil)
# Rate-limit login per IP: 5 gagal / 5 menit -> 429 sementara.
USERS_PATH = ROOT / "users.json"
SESSIONS_PATH = ROOT / "sessions.json"
AUTH_FLAG_PATH = ROOT / ".auth_enabled"
INVITE_PATH = ROOT / "invite.json"      # link registrasi sekali pakai (invite)

AUTH_COOKIE = "office_session"
SESSION_TTL_S = int(os.environ.get("AUTH_SESSION_TTL_S", str(12 * 3600)))
AUTH_MAX_ATTEMPTS = 5
AUTH_WINDOW_S = 300          # sliding window percobaan login per IP
PBKDF2_ITERS = 200_000       # OWASP 2023 minimum untuk PBKDF2-HMAC-SHA256
MIN_PW = 8
MAX_PW = 256
MIN_USER = 3
MAX_USER = 32

_auth_lock = threading.RLock()
_auth_attempts = {}          # ip -> [epoch, ...] percobaan login gagal


def auth_required():
    """Autentikasi SELALU aktif (termasuk port 8765 polos — port terbuka ke publik).

    Sebelum user pertama terdaftar, "mode" = register: halaman registrasi yang
    ditampilkan, dan semua /api/* tetap 401. Tanpa ini siapa pun yang menang
    registrasi pertama menguasai instance, dan jalur tanpa login tetap terbuka.
    """
    return True


def _atomic_json(path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def _load_users():
    try:
        raw = json.loads(USERS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items()
            if isinstance(v, dict) and isinstance(v.get("salt"), str)
            and isinstance(v.get("hash"), str)}


def _load_sessions():
    try:
        raw = json.loads(SESSIONS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if isinstance(v, dict)}


def _save_sessions(sessions):
    try:
        _atomic_json(SESSIONS_PATH, sessions)
    except OSError:
        pass


def _hash_password(password, salt_b64, iterations=PBKDF2_ITERS):
    salt = base64.b64decode(salt_b64.encode())
    return base64.b64encode(
        hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    ).decode()


def _valid_username(name):
    if not (MIN_USER <= len(name) <= MAX_USER):
        return False
    return bool(re.fullmatch(r"[A-Za-z0-9_.\-]+", name))


def _valid_password(pw):
    return MIN_PW <= len(pw) <= MAX_PW


def admin_add_user(username, password):
    """Tambah user via CLI (registrasi web ditutup setelah akun pertama).

    Dipakai dari server: cd <app> && python3 server.py --add-user <name>
    """
    if not _valid_username(username):
        return "username harus 3-32 karakter, hanya [A-Za-z0-9_.-]"
    if not _valid_password(password):
        return f"password minimal {MIN_PW} karakter"
    with _auth_lock:
        users = _load_users()
        if username in users:
            return "username sudah terdaftar"
        salt = base64.b64encode(secrets.token_bytes(16)).decode()
        users[username] = {"salt": salt,
                           "hash": _hash_password(password, salt),
                           "iterations": PBKDF2_ITERS,
                           "created_at": _iso(time.time())}
        _atomic_json(USERS_PATH, users)
        if not AUTH_FLAG_PATH.exists():
            try:
                AUTH_FLAG_PATH.write_text(_iso(time.time()), encoding="utf-8")
            except OSError:
                pass
    return None


def create_invite(ttl_hours=24):
    """Buat link registrasi sekali pakai (invite.json). Dipakai via CLI:
    python3 server.py --make-invite [ttl_jam]
    """
    token = secrets.token_urlsafe(24)
    now = time.time()
    data = {"token": token, "created_at": _iso(now),
            "expires_at": _iso(now + ttl_hours * 3600), "used": False}
    _atomic_json(INVITE_PATH, data)
    _audit("invite_created expires=" + data["expires_at"])
    return data


def invite_valid(token):
    """invite.json ada, belum dipakai, belum kedaluwarsa."""
    if not token or not isinstance(token, str):
        return False
    try:
        data = json.loads(INVITE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return False
    if data.get("used"):
        return False
    try:
        exp = time.mktime(time.strptime(data["expires_at"], "%Y-%m-%dT%H:%M:%S%z"))
    except Exception:
        return False
    if time.time() > exp:
        return False
    return hmac.compare_digest(str(data.get("token") or ""), token)


def consume_invite(token):
    """Tandai invite terpakai — harus dipanggil SETELAH registrasi sukses."""
    try:
        data = json.loads(INVITE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return
    if hmac.compare_digest(str(data.get("token") or ""), token or ""):
        data["used"] = True
        data["used_at"] = _iso(time.time())
        try:
            _atomic_json(INVITE_PATH, data)
        except OSError:
            pass
        _audit("invite_consumed")


def register_first(username, password, confirm, invite=None):
    """Registrasi TERTUTUP setelah akun pertama (403), KECUALI punya invite
    sekali pakai yang valid -> akun tambahan bisa dibuat lewat link undangan.
    """
    if _load_users() and not invite_valid(invite):
        return 403, {"ok": False, "error": "register_closed",
                     "detail": "registrasi ditutup; pakai link undangan "
                               "(?invite=...) atau tambah user via server "
                               "(python3 server.py --add-user <nama>)"}
    if password != confirm:
        return 400, {"ok": False, "error": "password_mismatch",
                     "detail": "konfirmasi password tidak sama"}
    if not _valid_username(username):
        return 400, {"ok": False, "error": "bad_username",
                     "detail": f"username {MIN_USER}-{MAX_USER} karakter, "
                               "hanya [A-Za-z0-9_.-]"}
    if not _valid_password(password):
        return 400, {"ok": False, "error": "bad_password",
                     "detail": f"password minimal {MIN_PW} karakter"}
    with _auth_lock:
        users = _load_users()
        if users and not invite_valid(invite):
            # race: user lain menang duluan (invite sendiri tetap boleh)
            return 403, {"ok": False, "error": "register_closed"}
        salt = base64.b64encode(secrets.token_bytes(16)).decode()
        users[username] = {"salt": salt,
                           "hash": _hash_password(password, salt),
                           "iterations": PBKDF2_ITERS,
                           "created_at": _iso(time.time())}
        try:
            _atomic_json(USERS_PATH, users)
        except OSError as exc:
            return 500, {"ok": False, "error": "storage_error", "detail": str(exc)}
        try:
            AUTH_FLAG_PATH.write_text(_iso(time.time()), encoding="utf-8")
        except OSError:
            pass
        token = _issue_session(username)
        if users and invite:
            consume_invite(invite)   # sekali pakai: tandai terpakai
    _audit(f"register user={username} client={getattr(_cur_client, 'ip', '?')}")
    return 200, {"ok": True, "username": username, "token": token,
                 "mode": "register"}


_cur_client = threading.local()   # client ip utk audit saat ini thread


def login_ok(ip, username, password):
    """-> (http_code, payload). Rate-limit per IP: 5 gagal / 5 menit -> 429."""
    now = time.time()
    with _auth_lock:
        hits = [t for t in _auth_attempts.get(ip, []) if now - t < AUTH_WINDOW_S]
        _auth_attempts[ip] = hits
        if len(hits) >= AUTH_MAX_ATTEMPTS:
            _save_login_attempts()
            return 429, {"ok": False, "error": "rate_limit",
                         "detail": f"terlalu banyak percobaan gagal, coba lagi "
                                   f"dalam {AUTH_WINDOW_S // 60} menit"}
        users = _load_users()
        if not users:
            # belum ada user -> arahkan ke registrasi, bukan menambah hit
            _save_login_attempts()
            return 400, {"ok": False, "error": "no_user",
                         "detail": "belum ada user, lakukan registrasi dahulu"}
        rec = users.get(username)
        ok = False
        if rec:
            try:
                expected = _hash_password(password, rec["salt"],
                                          int(rec.get("iterations", PBKDF2_ITERS)))
                ok = hmac.compare_digest(expected, rec["hash"])
            except Exception:
                ok = False
        if not ok:
            hits.append(now)
            _auth_attempts[ip] = hits
            _save_login_attempts()
            _audit(f"login_failed user={username!r} client={ip}")
            return 401, {"ok": False, "error": "bad_credentials",
                         "detail": "username atau password salah"}
        _auth_attempts.pop(ip, None)
        _save_login_attempts()
        token = _issue_session(username)
    _audit(f"login user={username} client={ip}")
    return 200, {"ok": True, "username": username, "token": token}


def _save_login_attempts():
    """Catat window percobaan ke disk agar restart tidak me-reset limiter."""
    try:
        _atomic_json(ROOT / ".login_attempts.json",
                     {ip: ts for ip, ts in _auth_attempts.items()
                      if any(time.time() - t < AUTH_WINDOW_S for t in ts)})
    except OSError:
        pass


def _load_login_attempts():
    global _auth_attempts
    try:
        raw = json.loads((ROOT / ".login_attempts.json").read_text(encoding="utf-8"))
    except Exception:
        raw = {}
    now = time.time()
    _auth_attempts = {ip: [t for t in v if isinstance(t, (int, float))
                           and now - t < AUTH_WINDOW_S]
                      for ip, v in (raw or {}).items() if isinstance(v, list)}
    _auth_attempts = {k: v for k, v in _auth_attempts.items() if v}


_load_login_attempts()


def _issue_session(username):
    token = secrets.token_urlsafe(32)
    with _auth_lock:
        sessions = _load_sessions()
        # bersihkan yang kedaluwarsa saat menulis
        sessions = {k: v for k, v in sessions.items()
                    if (v.get("exp") or 0) > time.time()}
        sessions[token] = {"user": username,
                           "exp": time.time() + SESSION_TTL_S,
                           "iat": time.time()}
        _save_sessions(sessions)
    return token


def session_user(token):
    """-> username bila token valid & belum kedaluwarsa, else None."""
    if not token:
        return None
    with _auth_lock:
        sessions = _load_sessions()
        rec = sessions.get(token)
        if not rec:
            return None
        if (rec.get("exp") or 0) <= time.time():
            sessions.pop(token, None)
            _save_sessions(sessions)
            return None
        return rec.get("user")


def logout(token):
    if not token:
        return
    with _auth_lock:
        sessions = _load_sessions()
        if sessions.pop(token, None) is not None:
            _save_sessions(sessions)
    _audit("logout")



def _iso(ts):
    """Epoch -> local ISO8601 with offset, or None."""
    if not ts:
        return None
    return datetime.fromtimestamp(float(ts)).astimezone().isoformat(timespec="seconds")


def list_profiles():
    """Canonical roster: codi first, then sorted dirs, default last (13 ids)."""
    ids = sorted(p.name for p in PROFILES_DIR.iterdir()
                 if p.is_dir() and not p.name.startswith(("_", ".")))
    return ["codi"] + [p for p in ids if p != "codi"] + ["default"]


# VO2D-F1: token @mention apa pun posisinya (awal/kalimat/tengah), bukan hanya
# ^@alias+spasi seperti parser frontend main.js.
MENTION_RE = re.compile(r"(?<![\w@])@([A-Za-z0-9_.:-]+)")
BROADCAST_TARGETS = ("all", "all-hands", "broadcast")


def _mention_hits(text, roster, alias_map):
    """Set profile-id yang disebut di ``text`` (case-insensitive).

    Resolve per token ke id roster ATAU key/value ALIAS (``@mave`` ->
    program-developer, ``@Dean`` -> code-analyst). Token tak dikenal
    (mis. ``@divisi-xyz``) diabaikan, bukan error.
    """
    lookup = {}
    for pid in roster:                      # id profil didahulukan
        lookup.setdefault(pid.lower(), pid)
    for key, val in alias_map.items():
        lookup.setdefault(str(key).lower(), key)   # ALIAS key   = profile-id
        lookup.setdefault(str(val).lower(), key)   # ALIAS value = display name

    found = set()
    for tok in MENTION_RE.findall(text or ""):
        pid = lookup.get(tok.lower())
        if pid in roster:
            found.add(pid)
    return found


def resolve_chat_targets(target, text, roster, alias_map):
    """Route sebuah pesan chat ke daftar profile-id (murni, tanpa side effect).

    ``target`` eksplisit profil -> ``[target]``; di luar roster -> ``[]``
    (pemanggil yang menolak). ``division:*`` di luar lingkup fungsi ini —
    pemanggil memegang cabang DIVISIONS seperti biasa.

    Broadcast (``all`` / ``all-hands`` / ``broadcast``): minimal satu mention
    match -> hanya profil itu yang diantre (hemat API — 1 run, bukan 11).
    Nol match -> roster penuh, persis perilaku broadcast lama sehingga default
    "# all-hands" tetap jalan normal.
    """
    if target not in BROADCAST_TARGETS:
        if target.startswith("division:"):
            return []                       # cabang DIVISIONS milik pemanggil
        return [target] if target in roster else []

    found = _mention_hits(text, roster, alias_map)
    if not found:
        return list(roster)                 # broadcast penuh (perilaku lama)
    return [pid for pid in roster if pid in found]  # dedupe, urutan roster


# ---------------------------------------------------------------------------
# Live activity detection (FINDINGS_DEAN.md §1)
# ---------------------------------------------------------------------------
_PID_RE = re.compile(r"(?:^|:)pid=(\d+)(?::|$)")
_PIDNS_RE = re.compile(r"(?:^|:)pidns=(\d+)(?::|$)")


def _local_pidns():
    try:
        m = re.search(r"\[(\d+)\]", os.readlink("/proc/self/ns/pid"))
        return m.group(1) if m else None
    except OSError:
        return None


def _holder_dead(holder):
    """True only on kernel proof the holder PID is gone (foreign pidns -> TTL)."""
    m = _PID_RE.search(holder or "")
    if not m:
        return False
    pid = int(m.group(1))
    if pid <= 0 or pid == os.getpid():
        return False
    rec = _PIDNS_RE.search(holder or "")
    if rec and (_local_pidns() is None or rec.group(1) != _local_pidns()):
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except OSError:
        return False
    return False


def _state_db(pid):
    return Path("/root/.hermes/state.db") if pid == "default" else PROFILES_DIR / pid / "state.db"


def detect_activity(now=None):
    """Per-profile live activity, read-only.

    Returns {pid: {'task': bool, 'session': bool, 'since': float|None,
                   'detail': str, 'desc': str, 'session_id': str|None,
                   'error': str|None}}

    task    = unexpired session_turn_leases row with a live holder (authoritative).
    session = last activity within SESSION_WINDOW (heuristic "recently active",
              labeled separately — SPEC §1 wants session activity exposed as
              activity, not merged into proof of task progress).
    """
    now = time.time() if now is None else now
    out = {}
    for pid in list_profiles():
        rec = {"task": False, "session": False, "since": None, "detail": "",
               "desc": "", "session_id": None, "error": None}
        db = _state_db(pid)
        if not db.exists():
            rec["error"] = "state.db missing"
            out[pid] = rec
            continue
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1.5)
            con.execute("pragma query_only=1")
            try:
                leases = con.execute(
                    "select conversation_id, holder, acquired_at, expires_at"
                    " from session_turn_leases where expires_at > ?", (now,)
                ).fetchall()
                last = con.execute(
                    "select id, coalesce(last_activity_at, started_at),"
                    " last_activity_description, title from sessions"
                    " order by coalesce(last_activity_at, started_at) desc limit 1"
                ).fetchone()
                msg_ts = con.execute("select max(timestamp) from messages").fetchone()[0]
            finally:
                con.close()
        except Exception as exc:  # unreadable probe -> status unknown, not idle
            rec["error"] = f"{type(exc).__name__}: {exc}"
            out[pid] = rec
            continue

        live = [l for l in leases if (l[3] or 0) > now and not _holder_dead(l[1])]
        if live:
            rec["task"] = True
            rec["since"] = min(l[2] or now for l in live)
            rec["session_id"] = live[0][0]
            rec["detail"] = f"session_turn_leases x{len(live)} alive"
        # Heuristic: recent session/message activity (Dean's secondary signal).
        newest = max([x for x in (msg_ts, last[1] if last else None) if x], default=None)
        if newest and (now - newest) <= SESSION_WINDOW:
            rec["session"] = True
            if not rec["task"]:
                rec["since"] = newest
                rec["detail"] = (f"[heuristic] last activity {int(now - newest)}s ago")
            rec["desc"] = (last[2] or last[3] or "") if last else ""
            if rec["session_id"] is None and last:
                rec["session_id"] = last[0]
        elif not rec["task"]:
            rec["detail"] = "idle" if newest else "no activity recorded"
        out[pid] = rec
    return out


# ---------------------------------------------------------------------------
# Kanban task list (read-only DB; NOT a busy signal — SPEC §1)
# ---------------------------------------------------------------------------
_KB = {"ts": 0.0, "tasks": [], "error": None, "lock": threading.Lock()}


def _kanban_read():
    tasks = []
    error = None
    try:
        dbs = sorted(KANBAN_BOARDS_DIR.glob("*/kanban.db"))
    except Exception as exc:
        return [], f"glob: {exc}"
    for db in dbs:
        board = db.parent.name
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2.0)
            con.execute("pragma query_only=1")
            try:
                rows = con.execute(
                    "select id, title, status, assignee, completed_at from tasks"
                    " where status in ('running','ready','blocked','done')"
                    " order by coalesce(started_at, created_at) desc"
                ).fetchall()
            finally:
                con.close()
        except Exception as exc:
            error = f"{board}: {type(exc).__name__}"
            continue
        for tid, title, status, assignee, _done in rows:
            if status == "done":
                continue  # done cards only feed the activity list, capped below
            aid = assignee or ""
            tasks.append({
                "id": tid, "title": title or "", "status": status,
                "assignee": aid, "assignee_name": ALIAS.get(aid, aid or "Belum ditugaskan"),
                "board": board,
            })
    return tasks, error


def kanban_cache():
    stale = time.time() - _KB["ts"] > 30
    if stale and _KB["lock"].acquire(blocking=False):
        try:
            if time.time() - _KB["ts"] > 30:
                tasks, err = _kanban_read()
                _KB["tasks"], _KB["error"], _KB["ts"] = tasks, err, time.time()
        finally:
            _KB["lock"].release()
    with _KB["lock"]:
        return list(_KB["tasks"]), _KB["error"]


# ---------------------------------------------------------------------------
# /api/office snapshot
# ---------------------------------------------------------------------------
_SNAP = {"ts": 0.0, "payload": None, "lock": threading.Lock()}


def _assemble(now=None):
    now = now if now is not None else time.time()
    pids = list_profiles()
    activity = detect_activity(now)
    tasks, kb_err = kanban_cache()

    # Config check: roster vs frozen desk slots (SPEC §2 — reject/report).
    errors = []
    unknown = [p for p in pids if p not in DESK_SLOT]
    missing = [p for p in FROZEN_ORDER if p and p not in pids]
    if unknown:
        errors.append(f"profile tanpa desk_slot: {','.join(unknown)}")
    if missing:
        errors.append(f"roster tidak lengkap, hilang: {','.join(missing)}")
    if kb_err:
        errors.append(f"kanban: {kb_err}")

    running_by_profile = {t["assignee"]: t for t in tasks if t["status"] == "running"}

    profiles = []
    probe_failures = []
    for pid in pids:
        act = activity.get(pid, {})
        probe_failed = bool(act.get("error"))
        task_run = bool(act.get("task"))
        recent_session = bool(act.get("session"))
        running_card = running_by_profile.get(pid)
        # busy/working: ONLY authoritative signals (FR-1.2). Kanban running card
        # without a lease counts as "working, source=kanban" (AC-1.3).
        busy = task_run or running_card is not None

        # current_task: running card first, else the leased session's title.
        cur = running_card
        if cur is None and task_run:
            title = act.get("desc") or ""
            if title:
                cur = {"id": act.get("session_id") or "", "title": title,
                       "status": "running", "assignee": pid,
                       "assignee_name": ALIAS.get(pid, pid), "board": None}

        if probe_failed:
            source = "unknown"
            probe_failures.append(pid)
        elif task_run:
            source = "lease"
        elif running_card is not None:
            source = "kanban"
        else:
            source = "idle"

        profiles.append({
            "id": pid,
            "display_name": ALIAS.get(pid, pid),
            "busy": busy,
            "working": busy,
            "status": ("unknown" if source == "unknown"
                       else "working" if busy else "available"),
            "source": source,                       # FR-1.2: lease|kanban|idle|unknown
            # Heuristic kept in a SEPARATE lane (never folded into busy):
            "recently_active": recent_session,
            "activity_source": "session" if recent_session else None,
            "activity_at": _iso(act.get("since")) if recent_session else None,
            "activity_at_lease": _iso(act.get("since")) if task_run else None,
            "current_task": cur,
            "desk_slot": DESK_SLOT.get(pid),
            # transparency fields (evidence detail)
            "activity_detail": act.get("detail") or None,
            "activity_note": act.get("desc") or None,
            "probe_error": act.get("error"),
            "since": _iso(act.get("since")) if act.get("since") else None,
            "session_id": act.get("session_id"),
        })

    busy_ids = [p["id"] for p in profiles if p["busy"]]
    kanban_busy = [p["id"] for p in profiles if p["source"] == "kanban"]
    session_busy = [p["id"] for p in profiles if p["recently_active"]]
    # FR-1.3: probe failure or kanban read failure degrades the payload.
    degraded = bool(probe_failures or kb_err)
    counts = {
        "profiles": len(profiles),
        "working": len(busy_ids),
        "kanban_busy": len(kanban_busy),
        "session_busy": len(session_busy),
        "recently_active": len(session_busy),
        "probe_failed": len(probe_failures),
    }

    recent = [{
        "time": time.strftime("%H:%M"),
        "text": f"🏠 {counts['profiles']} profile · {counts['working']} sedang bekerja",
        "source": "system",
    }]
    for p in profiles:
        if p["source"] == "lease" and p["since"]:
            mins = int((now - datetime.fromisoformat(p["since"]).timestamp()) / 60)
            recent.append({
                "time": time.strftime("%H:%M"),
                "text": f"🔴 {p['display_name']}: sedang bekerja ({mins} mnt)",
                "source": "lease",
            })
        elif p["recently_active"] and not p["busy"] and p["activity_at"]:
            mins = int((now - datetime.fromisoformat(p["activity_at"]).timestamp()) / 60)
            recent.append({
                "time": time.strftime("%H:%M"),
                "text": f"🟡 {p['display_name']}: baru saja aktif ({mins} mnt)",
                "source": "session",
            })
        if len(recent) >= 7:
            break
    for t in tasks[:4]:
        recent.append({"time": time.strftime("%H:%M"),
                       "text": f"{'▶' if t['status'] == 'running' else '•'} "
                               f"{t['assignee_name']}: {t['title'][:60]}",
                       "source": "kanban"})

    payload = {
        "ok": not errors,
        "degraded": degraded,
        "generated_at": _iso(now),
        "refresh_after_seconds": REFRESH_SECONDS,
        "poll_ms": REFRESH_SECONDS * 1000,     # FR-1.4: frontend uses this
        "profiles": profiles,
        "counts": counts,
        "tasks": tasks,
        "recent": recent[:12],
        "busy": busy_ids,
    }
    if degraded:
        problems = []
        if probe_failures:
            problems.append("probe gagal: " + ",".join(probe_failures))
        if kb_err:
            problems.append(f"kanban: {kb_err}")
        payload["degraded_reason"] = "; ".join(problems)
    if errors:
        payload["error"] = "; ".join(errors)
        payload["ok"] = False
    return payload


def office_payload():
    """Assembled snapshot, cached <=4s (SPEC §1). On failure: last good + ok:false."""
    with _SNAP["lock"]:
        if _SNAP["payload"] and time.time() - _SNAP["ts"] < SNAPSHOT_TTL:
            return json.loads(json.dumps(_SNAP["payload"]))
    try:
        payload = _assemble()
    except Exception as exc:
        with _SNAP["lock"]:
            last = _SNAP["payload"]
        payload = dict(last or {"profiles": [], "tasks": [], "recent": []})
        payload["ok"] = False
        payload["error"] = f"{type(exc).__name__}: {exc}"
        return payload
    with _SNAP["lock"]:
        _SNAP["payload"], _SNAP["ts"] = payload, time.time()
    return json.loads(json.dumps(payload))


# ---------------------------------------------------------------------------
# Chat: bounded queue, per-target serialization, persistence, audit
# ---------------------------------------------------------------------------
CHAT_PATH = ROOT / "chat.json"
AUDIT_PATH = ROOT / "chat_audit.log"
chat_lock = threading.RLock()
chat_log = []     # transcript entries (oldest first, capped)
outbox = {}       # msg_id -> {group, target, state, reply, error, updated_at}
_persist_dirty = False


def _load_chat():
    global chat_log, outbox
    try:
        raw = json.loads(CHAT_PATH.read_text(encoding="utf-8"))
    except Exception:
        return
    if isinstance(raw, list):          # legacy format: bare transcript
        chat_log = raw[-200:]
    elif isinstance(raw, dict):
        chat_log = (raw.get("log") or [])[-200:]
        outbox = raw.get("outbox") or {}


_load_chat()


def _persist_chat():
    """Caller must hold chat_lock."""
    global _persist_dirty
    try:
        tmp = CHAT_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"log": chat_log[-200:], "outbox": outbox,
                                   "saved_at": _iso(time.time())},
                                  ensure_ascii=False), encoding="utf-8")
        tmp.replace(CHAT_PATH)
        _persist_dirty = False
    except Exception:
        _persist_dirty = True  # retried on the next mutation


def _audit(line):
    try:
        with open(AUDIT_PATH, "a", encoding="utf-8") as f:
            f.write(f"{_iso(time.time())} {line}\n")
    except Exception:
        pass


def _group_state(group):
    items = [o for o in outbox.values() if o.get("group") == group]
    if not items:
        return None
    states = [o["state"] for o in items]
    if all(s == "replied" for s in states):
        return "replied"
    if any(s == "running" for s in states):
        return "running"
    if any(s == "queued" for s in states):
        return "queued"
    return "failed"


_pending = queue.Queue(maxsize=CHAT_QUEUE_MAX)
_target_locks = {}
_target_locks_guard = threading.Lock()
CONCURRENCY = threading.BoundedSemaphore(CHAT_WORKERS)


def _target_lock(target):
    with _target_locks_guard:
        if target not in _target_locks:
            _target_locks[target] = threading.Lock()
        return _target_locks[target]


def run_profile(profile, text):
    """Run one profile via the Hermes CLI. argv only — user text never hits a shell."""
    prompt = ("You have received a message in the Hermes Virtual Office from the user. "
              "Reply naturally and briefly to their message. Message: ") + text[:400]
    try:
        p = subprocess.run([HERMES_BIN, "-p", profile, "-z", prompt],
                           capture_output=True, text=True, timeout=CHAT_TIMEOUT_S,
                           cwd="/root")
    except subprocess.TimeoutExpired:
        return None, f"timeout setelah {CHAT_TIMEOUT_S}s"
    except OSError as exc:
        return None, f"spawn: {exc}"
    out = (p.stdout or "").strip() or (p.stderr or "").strip()
    if p.returncode != 0:
        return None, f"rc={p.returncode}: {out[:200]}"
    return out, None


def _set_state(msg_id, state, reply=None, error=None):
    with chat_lock:
        item = outbox.get(msg_id)
        if item is None:
            return
        item["state"] = state
        item["updated_at"] = _iso(time.time())
        if reply is not None:
            item["reply"] = reply[:1000]
        if error is not None:
            item["error"] = error[:300]
        for e in chat_log:
            if e.get("id") == msg_id or e.get("group") == item.get("group"):
                if e.get("group") == item.get("group"):
                    e["state"] = _group_state(item["group"]) or state
        _persist_chat()


def _deliver_worker():
    while True:
        msg_id = target = text = None
        try:
            msg_id, target, text = _get_nowait_blocking()
        except (queue.Empty, KeyboardInterrupt):
            return
        if msg_id is None:
            continue
        with CONCURRENCY:
            _set_state(msg_id, "running")
            _audit(f"run msg={msg_id} target={target}")
            with _target_lock(target):  # per-target serialization (SPEC §4)
                reply, err = run_profile(target, text)
        if err:
            _set_state(msg_id, "failed", error=err)
            _audit(f"failed msg={msg_id} target={target} err={err[:120]}")
            with chat_lock:
                chat_log.append({"sender": ALIAS.get(target, target),
                                 "text": f"(gagal: {err})",
                                 "time": time.strftime("%H:%M"),
                                 "target": target, "in_reply_to": msg_id})
                del chat_log[:-200]
                _persist_chat()
        else:
            _set_state(msg_id, "replied", reply=reply or "")
            _audit(f"replied msg={msg_id} target={target} chars={len(reply or '')}")
            with chat_lock:
                chat_log.append({"sender": ALIAS.get(target, target),
                                 "text": (reply or "(tanpa balasan)")[:600],
                                 "time": time.strftime("%H:%M"),
                                 "target": target, "in_reply_to": msg_id,
                                 "msg_ref": msg_id})
                del chat_log[:-200]
                _persist_chat()


def _get_nowait_blocking():
    """Block until an item is available; returns (msg_id, target, text)."""
    return _pending.get()


for _ in range(CHAT_WORKERS):
    threading.Thread(target=_deliver_worker, daemon=True).start()

# sliding-window rate limit per client
_rate = {}
_rate_lock = threading.Lock()


def _rate_ok(client):
    now = time.time()
    with _rate_lock:
        hits = [t for t in _rate.get(client, []) if now - t < 60]
        if len(hits) >= CHAT_RATE_PER_MIN:
            _rate[client] = hits
            return False
        hits.append(now)
        _rate[client] = hits
        return True


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):  # quiet stdout; errors surface via audit
        pass

    # ---- VO-OFFICE-R1: strip mount prefix (/office) sebelum routing ----
    def _bare_path(self):
        """Path tanpa querystring dan tanpa MOUNT_PREFIX.

        Apache: ProxyPass /office http://127.0.0.1:8765/ sudah me-strip, tapi
        backend tetap melayani /office/* langsung (mis. via curl 8765) supaya
        tidak ada dua jalur yang berbeda perilaku.
        """
        raw = urllib.parse.urlsplit(self.path).path
        if MOUNT_PREFIX and (raw == MOUNT_PREFIX or raw.startswith(MOUNT_PREFIX + "/")):
            raw = raw[len(MOUNT_PREFIX):] or "/"
        return raw

    def _json(self, obj, code=200, csrf=None):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if csrf is not None:
            self.send_header("Set-Cookie",
                             f"office_csrf={csrf}; Path=/; SameSite=Strict")
        self.end_headers()
        self.wfile.write(body)

    def _cookie(self, name):
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            k, _, v = part.strip().partition("=")
            if k == name:
                return v
        return None

    def _client_ip(self):
        peer = self.client_address[0] if self.client_address else "?"
        # Apache mod_proxy selalu menulis X-Forwarded-For. Tanpa ini semua
        # request di balik ProxyPass terlihat sebagai 127.0.0.1 -> rate-limit
        # login jadi satu ember (5 gagal dari siapa pun mengunci semua orang).
        # Hanya percaya XFF bila peer memang loopback (yakni Apache kita),
        # supaya klien luar tidak bisa memalsukan IP sendiri.
        if peer in ("127.0.0.1", "::1"):
            xff = (self.headers.get("X-Forwarded-For") or "").strip()
            if xff:
                # hop terakhir = yang ditambahkan proxy terdekat (Apache kita)
                return xff.split(",")[-1].strip() or peer
        return peer

    # ---- VO-OFFICE-R1: session cookie (HttpOnly, SameSite=Lax) ----
    def _session_token(self):
        return self._cookie(AUTH_COOKIE)

    def _authed_user(self):
        if not auth_required():
            return None
        return session_user(self._session_token())

    def _set_session_cookie(self, token):
        self.send_header("Set-Cookie",
                         f"{AUTH_COOKIE}={token}; Path=/; HttpOnly; "
                         f"SameSite=Lax; Max-Age={SESSION_TTL_S}")

    def _clear_session_cookie(self):
        self.send_header("Set-Cookie",
                         f"{AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")

    def _csrf_cookie(self):
        """Double-submit token: readable by same-origin JS, echoed on POST."""
        return self._cookie("office_csrf") or secrets.token_hex(16)

    def _csrf_needed(self):
        """Issue the cookie if absent; call AFTER send_response, before end_headers."""
        if not self._cookie("office_csrf"):
            self.send_header("Set-Cookie",
                             f"office_csrf={secrets.token_hex(16)}; Path=/; SameSite=Strict")

    # ---- F1 (QA_DEAN): strict static whitelist. The repo root is NEVER served;
    # only /, /index.html and /assets/<sanitized> resolve to real files.
    _ASSET_EXT = {".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".ico",
                  ".css", ".js", ".woff", ".woff2", ".ttf"}

    def translate_path(self, path):
        raw = self._bare_path()
        if raw in ("/", "/index.html"):
            return str(ROOT / "index.html")
        if raw.startswith("/assets/"):
            seg = urllib.parse.unquote(raw[len("/assets/"):])
            parts = seg.split("/")
            if seg and not any(p in ("", ".", "..") for p in parts):
                cand = (ROOT / "assets" / seg)
                try:
                    cand.resolve().relative_to((ROOT / "assets").resolve())
                except Exception:
                    return str(ROOT / "__denied__")
                if cand.is_file() and cand.suffix.lower() in self._ASSET_EXT:
                    return str(cand)
        return str(ROOT / "__denied__")   # no such file -> 404 (certs/, *.py, *.md, ...)

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 16384:
            return None
        raw = self.rfile.read(n) if n else b"{}"
        try:
            data = json.loads(raw)
        except Exception:
            return None
        return data if isinstance(data, dict) else None

    def _authorize_post(self):
        """CSRF + origin + optional token check for chat POST."""
        cookie = self._cookie("office_csrf")
        header = self.headers.get("X-Office-Csrf") or ""
        if not cookie or not hmac.compare_digest(cookie, header):
            return "csrf_token_missing_or_mismatch"
        origin = self.headers.get("Origin")
        if origin:
            host = self.headers.get("Host") or ""
            if not origin.rstrip("/").endswith(host):
                return "origin_mismatch"
        token = self.headers.get("X-Office-Token") or ""
        if OFFICE_TOKEN and not hmac.compare_digest(token, OFFICE_TOKEN):
            return "bad_token"
        return None

    # ---- VO-OFFICE-R1: auth routes ----
    def _auth_status(self):
        # Auth selalu aktif. mode: register = belum ada user (registrasi terbuka),
        # login = sudah ada user (registrasi ditutup).
        has_user = bool(_load_users())
        user = self._authed_user()
        self._json({"ok": True, "auth_required": True, "authenticated": bool(user),
                    "user": user,
                    "mode": "register" if not has_user else "login",
                    "csrf": self._csrf_cookie()}, csrf=self._csrf_cookie())

    def _handle_auth_post(self, action):
        """POST /api/auth/{register,login,logout} -> selalu JSON."""
        if action == "logout":
            logout(self._session_token())
            body = json.dumps({"ok": True}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self._clear_session_cookie()
            self.end_headers()
            self.wfile.write(body)
            return

        if action == "login":
            if not auth_required():
                self._json({"ok": False, "error": "no_user",
                            "detail": "belum ada user, lakukan registrasi dahulu"}, 400)
                return
            data = self._read_body() or {}
            user = (data.get("username") or "").strip()
            pw = data.get("password") or ""
            if not user or not pw:
                self._json({"ok": False, "error": "missing_fields",
                            "detail": "username dan password wajib diisi"}, 400)
                return
            ip = self._client_ip()
            code, payload = login_ok(ip, user, pw)
            if code == 200:
                body = json.dumps(payload, ensure_ascii=False).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self._set_session_cookie(payload["token"])
                self.end_headers()
                self.wfile.write(body)
                return
            self._json(payload, code)
            return

        if action == "register":
            data = self._read_body() or {}
            code, payload = register_first((data.get("username") or "").strip(),
                                           data.get("password") or "",
                                           data.get("confirm") or "",
                                           invite=data.get("invite") or None)
            if code == 200:
                body = json.dumps(payload, ensure_ascii=False).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self._set_session_cookie(payload["token"])
                self.end_headers()
                self.wfile.write(body)
                return
            self._json(payload, code)
            return

        self._json({"ok": False, "error": "unknown_action"}, 404)

    def do_GET(self):
        _cur_client.ip = self._client_ip()
        raw = urllib.parse.urlsplit(self.path).path
        # Redirect /office -> /office/. Tanpa trailing slash, index.html di URL
        # "/office" meresolve "assets/js/main.js" dan "api/office" ke root
        # (/assets/..., /api/...) yang TIDAK di-proxy -> 404 dan halaman kosong.
        if MOUNT_PREFIX and raw == MOUNT_PREFIX:
            query = urllib.parse.urlsplit(self.path).query
            self.send_response(302)
            self.send_header("Location", MOUNT_PREFIX + "/" + (f"?{query}" if query else ""))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        path = self._bare_path()
        if path.startswith("/api/auth/"):
            action = path.rsplit("/", 1)[-1]
            if action == "status":
                self._auth_status()
            else:
                self._json({"ok": False, "error": "method_not_allowed"}, 405)
            return
        if path.startswith("/api/"):
            # gate API: tanpa session valid -> 401 JSON (bukan HTML)
            if auth_required() and not self._authed_user():
                self._json({"ok": False, "error": "unauthorized",
                            "detail": "login diperlukan"}, 401)
                return
            if path.startswith("/api/office"):
                self._json(office_payload(), csrf=self._csrf_cookie())
                return
            if path.startswith("/api/chat"):
                tok = self._csrf_cookie()
                with chat_lock:
                    log = json.loads(json.dumps(chat_log[-100:]))
                    groups = {o.get("group"): _group_state(o["group"])
                              for o in outbox.values()}
                    groups = {k: v for k, v in groups.items() if k and v}
                self._json({"messages": log, "group_states": groups, "csrf": tok},
                           csrf=tok)
                return
            self._json({"ok": False, "error": "not_found"}, 404)
            return
        # Static: index.html & aset selalu dilayani (shell aplikasi + modal auth
        # dirender dari situ); DATA di balik /api/* tetap 401 tanpa session.
        super().do_GET()

    def end_headers(self):
        if self._bare_path() in ("/", "/index.html"):
            self._csrf_needed()
        # Anti-cache: semua respons statis + halaman selalu no-store.
        # Browser yang cache JS/CSS lama bikin halaman "muter-muter" setelah
        # perubahan kode — kirim no-store + no-cache + must-revalidate.
        self.send_header("Cache-Control",
                         "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


    def do_POST(self):
        _cur_client.ip = self._client_ip()
        path = self._bare_path()
        if path.startswith("/api/auth/"):
            self._handle_auth_post(path.rsplit("/", 1)[-1])
            return
        if not path.startswith("/api/chat"):
            self.send_error(404)
            return
        if auth_required() and not self._authed_user():
            self._json({"ok": False, "error": "unauthorized",
                        "detail": "login diperlukan"}, 401)
            return
        err = self._authorize_post()
        if err:
            self._json({"ok": False, "error": err}, 403)
            return
        client = self._client_ip()
        if not _rate_ok(client):
            self._json({"ok": False, "error": "rate_limit",
                        "detail": f"maks {CHAT_RATE_PER_MIN} pesan/menit"}, 429)
            return
        data = self._read_body()
        if data is None:
            self._json({"ok": False, "error": "bad_json"}, 400)
            return
        text = (data.get("text") or "").strip()
        target = (data.get("target_profile") or "").strip().lower()
        client_id = (data.get("client_message_id") or "").strip()[:64]

        if not target:
            self._json({"ok": False, "error": "target_required",
                        "roster": list_profiles()}, 400)
            return
        if not text:
            self._json({"ok": False, "error": "empty"}, 400)
            return
        if len(text) > CHAT_MAX_TEXT:
            self._json({"ok": False, "error": "text_too_long",
                        "max": CHAT_MAX_TEXT}, 400)
            return
        truncated = False
        if len(text) > CHAT_TRUNCATE_AT:
            text = text[:CHAT_TRUNCATE_AT] + " […]"
            truncated = True

        # target validation: exact roster allowlist or explicit division
        mention_reason = ""
        roster = list_profiles()
        if target in ("all", "all-hands", "broadcast"):
            # Broadcast: UI default "# all-hands" mengirim target=all
            # (tanpa ini semua pesan all-hands ditolak 400 — Dean review 12 Okt).
            # VO2D-F1: kalau text menyebut profil (mis. @harry) hanya profil itu
            # yang diantre — nol mention -> broadcast penuh seperti biasa.
            targets = resolve_chat_targets(target, text, roster, ALIAS)
            if len(targets) < len(roster):
                mention_reason = "reason=mention "
        elif target.startswith("division:"):
            div = target.split(":", 1)[1]
            if div not in DIVISIONS:
                # FR-4.2/AC-4.2: visible fallback, no subprocess, no silent save
                self._json({"ok": True, "delivered": False,
                            "error": "unknown_division",
                            "detail": "divisi tidak dikenal",
                            "valid": sorted(DIVISIONS)}, 200)
                return
            targets = DIVISIONS[div]
        else:
            if target not in roster:
                self._json({"ok": True, "delivered": False,
                            "error": "unknown_target",
                            "detail": "target tidak dikenal",
                            "valid": roster}, 200)
                _audit(f"post rejected client={client} target={target!r} unknown")
                return
            targets = [target]

        group = client_id or ("msg_" + secrets.token_hex(6))
        now_hm = time.strftime("%H:%M")

        # bounded queue: reject before creating any state (SPEC §4)
        if _pending.qsize() + len(targets) > CHAT_QUEUE_MAX:
            self._json({"ok": False, "error": "queue_full",
                        "detail": "antrean penuh, coba lagi"}, 429)
            return

        created = []
        with chat_lock:
            for t in targets:
                mid = group if len(targets) == 1 else f"{group}_{t}"
                outbox[mid] = {"group": group, "target": t, "state": "queued",
                               "reply": None, "error": None,
                               "updated_at": _iso(time.time())}
                created.append(mid)
            entry = {"id": group, "group": group, "sender": "You", "text": text,
                     "time": now_hm, "target": target,
                     "client_message_id": client_id or None}
            if truncated:
                entry["truncated"] = True
            if len(targets) == 1:
                entry["mention"] = targets[0]
            else:
                entry["notified"] = targets
            chat_log.append(entry)
            del chat_log[:-200]
            _persist_chat()
        queue_errors = 0
        for mid, t in zip(created, targets):
            try:
                _pending.put_nowait((mid, t, text))
            except queue.Full:
                queue_errors += 1
                _set_state(mid, "failed", error="queue_full")
        if queue_errors == len(created):
            self._json({"ok": False, "error": "queue_full"}, 429)
            return
        _audit(f"post client={client} group={group} {mention_reason}"
               f"targets={','.join(targets)} "
               f"chars={len(text)} queued={len(created) - queue_errors}")
        self._json({"ok": True, "delivered": True, "group": group,
                    "targets": targets, "state": "queued",
                    "truncated": truncated, "csrf": self._cookie("office_csrf")})

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()


if __name__ == "__main__":
    if len(os.sys.argv) >= 3 and os.sys.argv[1] == "--add-user":
        import getpass
        username = os.sys.argv[2]
        password = getpass.getpass(f"Password untuk {username}: ")
        error = admin_add_user(username, password)
        if error:
            raise SystemExit(error)
        print(f"User {username} ditambahkan.")
        raise SystemExit(0)
    if len(os.sys.argv) >= 3 and os.sys.argv[1] == "--make-invite":
        ttl = float(os.sys.argv[2])
        inv = create_invite(ttl)
        print(f"INVITE_TOKEN={inv['token']}")
        print(f"EXPIRES={inv['expires_at']}")
        raise SystemExit(0)
    port = int(os.environ.get("PORT", "8765"))
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"PixelOffice server on http://0.0.0.0:{port}", flush=True)
    srv.serve_forever()
