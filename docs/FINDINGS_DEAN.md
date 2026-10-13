# FINDINGS — Dean (analyst, read-only): detecting which Hermes profiles are "sedang bekerja" RIGHT NOW

Date: 2026-10-11 21:15 WIB. All probing was read-only; no shared file was modified.

## TL;DR

**The reliable signal is `session_turn_leases` in each profile's own `state.db`.**
Hermes acquires one row per executing turn, refreshes it every ~60s (TTL 300s), and
DELETEs it when the turn finishes (`hermes_state_compression.py:673 release_session_turn_lease`).
An unexpired row == a turn is executing right now. Kanban status is useless (all 41 cards 'done'),
and `processes.json` / pid files track spawned *child* processes (servers), not agent turns.

---

## 1. The runnable function

Stdlib-only, read-only, runs in **0.02s** for all 13 profiles. Copy-paste runnable:

```python
"""Live 'working' detection for Hermes profiles — stdlib only, read-only."""
import glob, os, re, sqlite3, time
from datetime import datetime, timezone

STALL_S = 600        # heuristic: profile with no message/turn in this long = idle
PROFILE_DIR = "/root/.hermes/profiles"
PID_RE = re.compile(r"(?:^|:)pid=(\d+)(?::|$)")
PIDNS_RE = re.compile(r"(?:^|:)pidns=(\d+)(?::|$)")

def _local_pidns():
    """Inode of /proc/self/ns/pid, or None (mirrors hermes_state_pidns)."""
    try:
        m = re.search(r"\[(\d+)\]", os.readlink("/proc/self/ns/pid"))
        return m.group(1) if m else None
    except OSError:
        return None

def _holder_dead(holder):
    """True only on kernel proof the holder's PID is gone (foreign pidns -> not dead)."""
    m = PID_RE.search(holder or "")
    if not m:
        return False
    pid = int(m.group(1))
    if pid <= 0 or pid == os.getpid():
        return False
    rec = PIDNS_RE.search(holder or "")
    if rec:                          # stamped: only trust it in our namespace
        if _local_pidns() is None or rec.group(1) != _local_pidns():
            return False             # foreign namespace -> defer to TTL
    elif os.name == "posix" and os.path.isdir("/proc/self/ns"):
        return False                 # unstamped + pidns platform -> defer to TTL
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except OSError:
        return False
    return False

def _iso(ts):
    if not ts:
        return None
    return datetime.fromtimestamp(float(ts), timezone.utc).isoformat(timespec="seconds")

def _read_ro(path, fn):
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2.0)
        con.execute("pragma query_only=1")
        try:
            return fn(con.cursor())
        finally:
            con.close()
    except Exception as exc:
        return exc

def detect_working():
    """{profile_id: {'working': bool, 'since': iso|None, 'detail': str}} for every profile.

    PRIMARY signal (authoritative): an unexpired `session_turn_leases` row in that
    profile's state.db whose holder PID is provably alive. Hermes acquires this lease
    on turn admission, refreshes it every 60s while the turn runs (TTL 300s) and
    DELETEs it on turn release (hermes_state_compression.py:673). A row therefore
    means "a turn is executing right now" — not merely a recent message.

    SECONDARY signal (HEURISTIC): latest `sessions.last_activity_at` /
    `max(messages.timestamp)` within STALL_S. This says "recently active", not
    "executing"; Hermes persists last_activity_at across turns, so it can be
    stale-but-recent after a turn ends, and a long streaming tool call with no DB
    write would be missed. Marked '[heuristic]' in `detail`.
    """
    now = time.time()
    out = {}
    dbs = sorted(glob.glob(os.path.join(PROFILE_DIR, "*", "state.db")))
    root_db = os.path.join(os.path.dirname(PROFILE_DIR.rstrip("/")), "state.db")
    if os.path.exists(root_db):
        dbs.append(root_db)

    def probe(cur):
        leases = cur.execute(
            "SELECT conversation_id, holder, acquired_at, expires_at "
            "FROM session_turn_leases WHERE expires_at > ?", (now,)
        ).fetchall()
        last = cur.execute(
            "SELECT COALESCE(last_activity_at, started_at), last_activity_description, title "
            "FROM sessions ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 1"
        ).fetchone()
        msg_ts = cur.execute("SELECT max(timestamp) FROM messages").fetchone()[0]
        return leases, last, msg_ts

    for db in dbs:
        prof = os.path.basename(os.path.dirname(db))
        if "profiles" not in db:
            prof = "default"
        r = _read_ro(db, probe)
        if isinstance(r, Exception):
            out[prof] = {"working": False, "since": None,
                         "detail": f"unreadable: {r.__class__.__name__}"}
            continue
        leases, last, msg_ts = r
        live = [l for l in leases if not _holder_dead(l[1])]
        if live:
            since = min(l[2] for l in live)
            kinds = sorted({(l[1].split(":platform=")[-1] if ":platform=" in l[1] else "turn")
                            for l in live})
            desc = (last[1] or last[2] or "turn active") if last else "turn active"
            out[prof] = {"working": True, "since": _iso(since),
                         "detail": f"session_turn_leases x{len(live)} alive "
                                   f"(platform={','.join(kinds)}) — {desc}"}
            continue
        newest = max([x for x in (msg_ts, last[0] if last else None) if x], default=None)
        age = now - newest if newest else None
        if age is not None and age <= STALL_S:
            out[prof] = {"working": True, "since": _iso(newest),
                         "detail": f"[heuristic] no live lease; last activity "
                                   f"{int(age)}s ago — {last[1] or last[2] or ''}".strip()}
        else:
            why = "no activity recorded" if age is None else f"idle {int(age)}s"
            out[prof] = {"working": False, "since": None, "detail": why}
    return out

if __name__ == "__main__":
    import json, time
    t0 = time.time()
    res = detect_working()
    print(json.dumps(res, indent=2))
    print(f"[{time.time()-t0:.2f}s]")
```

Also saved at `/root/.hermes/profiles/codi/cache/scratch/detect_working.py` (scratch, not a shared file).

### How to read `detail`
- `session_turn_leases xN alive (...)` → **authoritative**, a turn is running.
- `[heuristic] ... last activity Ns ago` → recently active but no live lease; treat as
  "maybe working" only if you accept a softer signal. For a dashboard avatar sitting at
  a desk, I'd only use the authoritative branch, or show the heuristic with a different badge.
- `idle Ns` / `no activity recorded` → not working.

### Known honesty caveats
1. **A turn can run >300s without a lease?** No — the lease is *refreshed* every 60s while
   the turn runs (`DurableTurnLease`, `refresh_interval=60`, `LEASE_TTL_SECONDS=300`).
   So a live turn always holds an unexpired row. Good.
2. **False positive window:** if a turn dies hard without releasing, its row survives until
   `expires_at` (≤300s). The holder PID here is the *gateway* (pid 909), which stays alive,
   so the PID check won't reap it — worst case ~5 min of "sedang bekerja" after a crash.
   This is by design (Hermes defers to TTL).
3. **False negative window:** none observed for turns; a profile with *no* state.db (none here)
   reports `unreadable`/False.
4. **Subagents** appear as leases under the *parent* profile's state.db (source='subagent'),
   which is correct: codi shows x2 (its telegram turn + my subagent turn).
5. The `sessions.last_activity_at` heuristic can be recent-but-finished — that's why it's
   flagged `[heuristic]` and should not be merged silently with the authoritative signal.

---

## 2. Sources tested

| Source | Command | What it showed | Distinguishes running vs idle? |
|---|---|---|---|
| **`<profile>/state.db` → `session_turn_leases`** | `sqlite3 … 'select … where expires_at > strftime('%s','now')'` | Rows only for codi (x2) + amanda (x1); zero for all 11 others | ✅ **YES — authoritative.** Acquired on turn start, refreshed 60s, deleted on turn end |
| `<profile>/state.db` → `sessions.last_activity_at` / `last_activity_description` | `order by COALESCE(last_activity_at,started_at) desc limit 1` | codi: "delegate_task: subagent receiving stream response (iteration 19/250)"; amanda: "receiving stream response" | ⚠️ Heuristic — good as a *description* label, but recent ≠ executing |
| `<profile>/state.db` → `max(messages.timestamp)` | `select max(timestamp) from messages` | codi 0.0s old, amanda ~40s old; others 54k–471k s | ⚠️ Heuristic, same caveat |
| `kanban.db` | (given) | all 41 cards 'done' even while running | ❌ NO — useless for live state |
| `ps -eo pid,etimes,args \| grep -i hermes` | shown in §3 | Only 2 long-lived `hermes` processes: **pid 909 = gateway run, pid 910 = dashboard**. No `-p <profile>` args anywhere | ❌ NO — the gateway multiplexes all 13 profiles in one process; cannot map PID→profile |
| `<profile>/processes.json` | `cat codi/processes.json` | One entry: `python3 server.py` pid 2701720 — the virtual-office web server, `owner_task_id` = a *finished* session | ❌ NO for turns — tracks spawned child processes only; goes stale |
| `<profile>/state/dashboard_clients.heartbeat`, `cron/ticker_heartbeat` | `stat` / `cat` | ticker_heartbeat updates every ~1s **for all 12 profiles equally** (it's the shared cron ticker, all with pid 909) | ❌ NO — proves gateway is alive, not that a profile works |
| `<profile>/cron/.fire-*.lock`, `state.db.*.lock`, `auth.lock` | `find -name '*lock'` | All near-zero-byte, mtime tracks unrelated admin events (e.g. all `auth.lock` touched 21:02 by a sweep) | ❌ NO — not per-turn |
| `/root/.hermes/gateway_state.json` | `cat` | `"active_agents":2`, `"active_work":null`, `served_profiles:[13]` | ⚠️ Count only (2 = codi+amanda, matches!), **no profile attribution** and `active_work` was null |
| `<profile>/state.db` → `gateway_heartbeats` | `select … from gateway_heartbeats` | Only codi + ROOT have rows, and they're hours stale (41k–538k s) | ❌ NO — tracks gateway backends, not turns |
| `<profile>/state.db` → `async_delegations.status` | `select * from async_delegations` | One `status='running'` row for codi (deleg_d68897d9, started 21:09) — **independently corroborates codi** | ✅ Good corroborating signal for delegate tasks, but only covers `delegate_task` work, not plain turns |

---

## 3. Raw evidence that codi is detected as working RIGHT NOW

**(a) The function's own output (run 21:14 WIB, 0.02s):**
```json
"codi": {
  "working": true,
  "since": "2026-10-11T14:06:45+00:00",
  "detail": "session_turn_leases x2 alive (platform=subagent,telegram) — receiving stream response"
},
"amanda": { "working": true, ... },
"code-analyst": { "working": false, "detail": "idle 54489s" },
... (11 other profiles all working:false)
[0.02s]
```

**(b) Underlying lease rows — codi's state.db:**
```
$ sqlite3 -header -column /root/.hermes/profiles/codi/state.db \
  "select conversation_id, holder, acquired_at, expires_at from session_turn_leases where expires_at > strftime('%s','now')"
conversation_id           holder                                        acquired_at   expires_at
20261011_100545_bf613a37  pid=909:pidns=4026531836:turn=…:platform=telegram     1791727605.5963  1791728385.81881
20261011_210925_cef27e    pid=909:pidns=4026531836:turn=…:platform=subagent     1791727765.25357 1791728425.40221
```
(the second row is *this* Dean subagent turn; the first is codi's telegram turn)

**(c) Join to session metadata — proves it's live work, not residue:**
```
$ sqlite3 -header -column codi/state.db "select s.profile_name, s.source, s.last_activity_description
    from session_turn_leases l join sessions s on s.id=l.conversation_id where l.expires_at > strftime('%s','now')"
profile_name  source    last_activity_description
codi          telegram  delegate_task: subagent receiving stream response (iteration 19/250)
codi          subagent  receiving stream response
```

**(d) Process check (shows why `ps` alone can't attribute profiles):**
```
$ ps -eo pid,etimes,comm,args | grep -E 'hermes|gateway' | grep -v grep
909  272169 hermes  ... main.py gateway run          <- ONE gateway for all 13 profiles
910  272169 hermes  ... dashboard --no-open
```

**(e) Independent corroboration — async_delegations still `running` for codi:**
```
('deleg_d68897d9', 'agent:codi:telegram:dm:1208418777', ..., 'running', started 1791727765.23)
```

**(f) Ground truth from context:** the task states codi *and* amanda are both actively
running right now — `detect_working()` returns exactly `{codi: True, amanda: True}` and
False for the other 11. No false positives, no false negatives in this sample.

---

## 4. Could NOT verify

- **No negative/stress test:** I did not kill a running turn to measure how long a stale
  lease lingers (expected ≤300s by TTL, but not empirically timed here).
- **`gateway_state.json.active_work` semantics:** it was `null` during an obviously active
  period; I found it *written* in `gateway/run_shutdown.py` but did not trace exactly when
  it's populated — treat as unusable until someone confirms.
- **Cross-host / multi-gateway:** only one host and one gateway (pid 909) exist here; the
  pidns logic is written defensively but was exercised only in the single-namespace case.
- **Profiles outside these 13** (e.g. if a profile's state.db lived elsewhere) would be missed;
  the function enumerates `/root/.hermes/profiles/*/state.db` plus `/root/.hermes/state.db`
  (reported as `default`).
- **`sessions.ended_at`** was not used as a signal (I read but didn't rely on it); whether a
  turn can hold a lease with `ended_at` already set is unverified.

## Recommendation for the dashboard
Call `detect_working()` on a 5–10s poll (it costs 0.02s). Put the avatar at the desk when
`working is True` **and** `detail` starts with `session_turn_leases`; show the
`[heuristic]` case with a distinct, softer state (e.g. "baru saja bekerja") rather than
mixing it into "sedang bekerja". `since` gives you the "sejak kapan" tooltip directly.
