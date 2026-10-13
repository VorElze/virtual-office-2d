// animation.js — movement state machine + asset loading + RAF animation.
// Anti-freeze guarantees: bounded delta, no recursive timers, RAF only while
// movement or sprite frames need updates; each agent always lands at a cell.

import { GRID, COLS, ROWS, WORLD_W, WORLD_H, idx, cellCenter, DESKS, ROAM_SPOTS, ZONES, zoneAt, buildWalkMask } from './map.js';
import { findPath, nearestFree } from './pathfinding.js';

const ASSET_ROOT = '/assets';
const SPRITE_SIZE = 32;
const SPEED = 88; // world pixels / second
const FRAME_MS = 230;
const IDLE_REST_MS = 2200;
const MAX_DELTA = 0.06;
const sprites = new Map();
// Warning fallback sprite: sekali per key ('profile' / 'profile:pose') supaya
// degradasi terlihat di console tanpa membanjiri log (11 avatar x 4 pose).
const spriteWarned = new Set();
const DEFAULT_POSE_ROOT = 'default';

function warnSpriteFallback(key, attemptedSrc) {
  if (spriteWarned.has(key)) return;
  spriteWarned.add(key);
  console.warn(`[animation] sprite tidak ditemukan: ${attemptedSrc} — memakai fallback ${DEFAULT_POSE_ROOT}_*`);
}

function loadImage(src) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

async function loadSprite(profile, pose) {
  const safe = encodeURIComponent(profile || 'default');
  const key = `${safe}_${pose}`;
  if (sprites.has(key)) return sprites.get(key);
  const src = `${ASSET_ROOT}/chars/${safe}_${pose}.png`;
  let image = await loadImage(src);
  if (!image && safe !== DEFAULT_POSE_ROOT) {
    // Fallback WAJIB: tanpa ini resolve(null) tersimpan di cache dan draw()
    // diam-diam merender kotak warna — avatar hilang pose tanpa error
    // (bug senyap lama: animation.js:384 if (image)).
    warnSpriteFallback(key, src);
    image = await loadImage(`${ASSET_ROOT}/chars/${DEFAULT_POSE_ROOT}_${pose}.png`);
  }
  sprites.set(key, image);
  return image;
}

/** §8.1: probe_error dikirim server sebagai STRING ('state.db missing' /
 *  'OperationalError: ...') atau null — bukan boolean. status/source juga bisa
 *  berupa string 'unknown' eksplisit (server.py:296-312), bukan hanya null. */
function isUnknownTelemetry(profile) {
  const probe = profile?.probe_error;
  const probeFailed = probe === true
    || (typeof probe === 'string' && probe.trim().length > 0);
  return probeFailed
    || profile?.status === 'unknown'
    || profile?.source === 'unknown'
    || profile?.status == null
    || profile?.source == null;
}

// Backward-compatible alias (nama lama dipertahankan agar modul lain aman).
const isKnownTelemetry = isUnknownTelemetry;

/** §8 status policy: working=true HIJAU; telemetry unknown/error MERAH; other KUNING. */
export function statusKind(profile) {
  if (profile?.working === true) return 'working';
  if (isUnknownTelemetry(profile || {})) return 'unknown';
  return 'available';
}

/** FR-C3: profil yang bekerja memakai sprite duduk (_sit), bukan berdiri. */
export function profilePose(kind) {
  return kind === 'working' ? 'sit' : 'idle';
}

/** FR-C4: label menjelaskan arti merah = observabilitas tidak diketahui. */
export function statusLabel(kind) {
  if (kind === 'working') return 'sedang bekerja';
  if (kind === 'unknown') return 'status tidak diketahui';
  return 'tersedia';
}

function profileKey(profile, i) {
  return String(profile?.profile || profile?.name || profile?.id || `agent-${i + 1}`);
}

/** VO2D-F3: teks VISIBLE di atas avatar = alias (display_name) huruf kecil,
 *  fallback ke id bila alias tidak ada (jangan pernah render "undefined").
 *  aria-label / title / dataset.agent TETAP memakai id asli untuk QA/selectors
 *  — hanya tampilan yang berubah. Lowercase diterapkan di sini (satu cara,
 *  konsisten), bukan lewat CSS. */
function agentLabel(agent) {
  const alias = agent?.profile?.display_name;
  const raw = (typeof alias === 'string' && alias.trim()) ? alias.trim() : agent?.id;
  return String(raw ?? '').toLowerCase() || 'agent';
}
// Diekspor untuk __office.state (QA membaca label terlihat tanpa memecah modul).
export { agentLabel };

/** VO2D-F3: area klik papan tulis Meeting Room — HASIL KALIBRASI PIKSEL,
 *  bukan angka tebakan. room_meeting_room.png (457x209) ditempel dengan origin
 *  (556,40); blok putih papan terdeteksi pada png x343..391 y44..74 (satu-satunya
 *  run terang >=30px di seluruh room; RGB inti ~231,231,231 netral putih)
 *  -> world x899..947 y84..114. Angka body kartu c=24,r=1 (x768..800) TERBUKTI
 *  SALAH (area dinding). Margin +5px agar tap mobile tidak meleset. */
const WHITEBOARD_HIT = { x0: 894, y0: 79, x1: 952, y1: 119 };

function hitWhiteboard(x, y) {
  return x >= WHITEBOARD_HIT.x0 && x <= WHITEBOARD_HIT.x1
    && y >= WHITEBOARD_HIT.y0 && y <= WHITEBOARD_HIT.y1;
}

function pickColor(profile) {
  const kind = statusKind(profile);
  return kind === 'working' ? '#37a86c' : kind === 'unknown' ? '#dd5360' : '#e3a633';
}

function validDeskSlot(profile) {
  const n = Number(profile?.desk_slot);
  return Number.isInteger(n) && n >= 0 && n < DESKS.length ? n : null;
}

function activeTask(profile, tasks) {
  const key = profileKey(profile);
  return tasks.find((t) => (t.assignee || t.profile || t.owner) === key && t.status === 'running');
}

async function profileIdle(profile, kind = 'available') {
  return loadSprite(profileKey(profile), profilePose(kind));
}

function choice(array, seed) {
  return array.length ? array[Math.abs(seed) % array.length] : [12, 6];
}

export class OfficeAnimator {
  constructor({ canvas, profiles = [], tasks = [], scale = 1, onAgentClick = () => {}, onWhiteboardClick = () => {}, base = null, props = [] }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.profiles = profiles;
    this.tasks = tasks;
    this.scale = scale;
    this.onAgentClick = onAgentClick;
    this.onWhiteboardClick = onWhiteboardClick; // VO2D-F3: klik papan -> modal Kanban
    this.base = base; // offscreen canvas berisi peta (lantai+dinding+prop)
    this.props = props;
    this.mask = buildWalkMask({ excludeMeeting: true });
    this.agents = [];
    this.labelLayer = this.ensureLabelLayer();
    this.raf = 0;
    this.lastTs = 0;
    this.disposed = false;
    this.resizeCanvas();
    this.initAgents();
    this.installClick();
  }

  setBase(base) {
    this.base = base;
    this.draw();
  }

  resizeCanvas() {
    // Ukuran world dari ekspor R1 (map.js WORLD_W/WORLD_H = 1056x544),
    // bukan hitungan lokal — satu sumber kebenaran dengan main.js drawBase().
    this.canvas.width = WORLD_W;
    this.canvas.height = WORLD_H;
    this.canvas.style.width = `${WORLD_W}px`;
    this.canvas.style.height = `${WORLD_H}px`;
  }

  async initAgents() {
    const workingSlots = new Set();
    const list = this.profiles;
    for (let i = 0; i < list.length; i += 1) {
      const profile = list[i];
      const kind = statusKind(profile);
      const task = activeTask(profile, this.tasks);
      let deskSlot = kind === 'working' ? validDeskSlot(profile) : null;
      if (deskSlot == null && kind === 'working') {
        // Stable fallback avoids all workers stacking in one seat.
        deskSlot = i % DESKS.length;
        while (workingSlots.has(deskSlot)) deskSlot = (deskSlot + 1) % DESKS.length;
      }
      if (deskSlot != null) workingSlots.add(deskSlot);
      const start = deskSlot != null ? DESKS[deskSlot].seat : choice(ROAM_SPOTS, i * 7 + 3);
      const [x, y] = cellCenter(start[0], start[1]);
      const profileName = profileKey(profile, i);
      const image = await profileIdle(profile, kind);
      const agent = {
        id: profileName,
        profile,
        kind,
        task,
        image,
        x, y,
        home: start,
        deskSlot,
        path: [],
        segment: 0,
        walking: false,
        frame: 0,
        frameAt: 0,
        idleAt: 0,
        nextRoamAt: 800 + ((i * 613) % 2800),
        direction: 'down',
        color: pickColor(profile),
        seed: i + 1,
        error: isUnknownTelemetry(profile),
        pose: profilePose(kind),
        breathAt: 0,
        tag: null,
      };
      agent.tag = this.makeTag(agent);
      this.agents.push(agent);
    }
    if (!this.disposed) this.draw();
    // Kick the RAF loop: without it nothing ever calls updateAgent, so roaming
    // triggers (nextRoamAt) never fire and the office stays frozen.
    if (!this.disposed) this.start();
  }

  installClick() {
    // VO2D-F3: satu jalur hit-test dipakai semua input. Tap sentuh menghasilkan
    // pointerup + click (mouse juga berpasangan) — dedupe membandingkan koordinat
    // hampir sama dalam window singkat, sehingga tap TUNGGAL hanya diproses sekali
    // tanpa menelan klik beruntun yang sah di posisi berbeda.
    let lastTap = null;
    const runHitTest = (event) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) * (this.canvas.width / rect.width);
      const y = (event.clientY - rect.top) * (this.canvas.height / rect.height);
      const now = performance.now();
      if (lastTap && now - lastTap.at < 500
        && Math.abs(lastTap.x - x) < 2 && Math.abs(lastTap.y - y) < 2) return;
      lastTap = { at: now, x, y };
      let nearest = null;
      let best = Infinity;
      for (const agent of this.agents) {
        // Hit-test pakai bounding box sprite aktual (anchor kaki = agent.x/y,
        // naik setinggi tinggi sprite) — bukan radius lingkaran tetap, supaya
        // kepala avatar (di atas kaki ~20px) ikut terklik. Anchor kaki sudah
        // mengikuti seat anchor R1 (DESKS[].seat via cellCenter), jadi cukup
        // pakai agent.x/y apa adanya.
        const img = agent.image;
        const w = img ? img.width : 12;
        const h = img ? img.height : 18;
        const left = agent.x - w / 2;
        const top = agent.y - h + 4;
        const right = left + w;
        const bottom = agent.y + 4;
        if (x >= left && x <= right && y >= top && y <= bottom) {
          // Pilih yang paling dekat ke titik klik (untuk kasus tumpang tindih).
          const d = Math.hypot(agent.x - x, (top + bottom) / 2 - y);
          if (d < best) { nearest = agent; best = d; }
        }
      }
      // Prioritas 1: avatar (drawer profile) — avatar di dekat papan tetap menang.
      if (nearest) { this.onAgentClick(nearest.profile, nearest.task, nearest.kind); return; }
      // Prioritas 2: papan tulis Meeting Room -> modal Kanban (VO2D-F3).
      if (hitWhiteboard(x, y)) this.onWhiteboardClick(x, y);
    };
    // pointerup = jalur utama (mouse & sentuh); click dipakai sebagai cadangan
    // bila browser tidak memancarkan pointer events (guard dedupe di atas).
    this.canvas.addEventListener('pointerup', runHitTest);
    this.canvas.addEventListener('click', runHitTest);
    // Opsional desktop: cursor pointer saat hover di area papan tulis.
    this.canvas.addEventListener('mousemove', (event) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) * (this.canvas.width / rect.width);
      const y = (event.clientY - rect.top) * (this.canvas.height / rect.height);
      this.canvas.style.cursor = hitWhiteboard(x, y) ? 'pointer' : '';
    }, { passive: true });
  }

  /** FR-C5: layer DOM transparan di atas kanvas untuk label nama + titik status. */
  ensureLabelLayer() {
    let layer = this.canvas.parentElement?.querySelector(':scope > .avatar-labels');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'avatar-labels';
      layer.setAttribute('aria-hidden', 'false');
      this.canvas.insertAdjacentElement('afterend', layer);
    }
    return layer;
  }

  /** FR-C5 + FR-C4: tag nama dengan titik status & tooltip penjelas arti merah.
   *  Struktur: .avatar (posisi, mengikuti kepala) > .nametag > .dot + nama.
   *  Kelas .avatar dipakai QA/AC-C5 sebagai pembanding jumlah avatar vs tag. */
  makeTag(agent) {
    if (!this.labelLayer) return null;
    const node = document.createElement('span');
    node.className = 'avatar';
    node.dataset.agent = agent.id;
    node.setAttribute('aria-label', `${agent.id} — ${statusLabel(agent.kind)}`);
    node.title = `${agent.id} — ${statusLabel(agent.kind)}`;
    const tag = document.createElement('span');
    tag.className = `nametag ${agent.kind}`;
    const dot = document.createElement('i');
    dot.className = `dot ${agent.kind}`;
    dot.setAttribute('aria-hidden', 'true');
    tag.appendChild(dot);
    // VO2D-F3: teks VISIBLE = alias lowercase; id asli tetap di aria-label/title.
    tag.appendChild(document.createTextNode(agentLabel(agent)));
    node.appendChild(tag);
    this.labelLayer.appendChild(node);
    return node;
  }

  /** Sinkronkan posisi tag mengikuti pusat avatar tiap frame.
   *  Layer seukuran kanvas dan ikut di-scale #canvasWrap, jadi
   *  koordinatnya langsung px kanvas (jangan dikali zoom lagi).
   *  Anti-tumpang-tindih (R3): bila dua tag berada <40px horizontal dan
   *  <12px vertikal, tag urutan belakang digeser naik bertingkat sehingga
   *  label tidak saling menutupi saat avatar berdekatan (mis. 8 kursi blok A). */
  syncTags() {
    if (!this.labelLayer) return;
    const placed = [];
    // Urutkan deterministik (id) supaya offset stabil antar frame.
    const list = this.agents.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const agent of list) {
      const tag = agent.tag;
      if (!tag || !tag.isConnected) continue;
      let lift = 0;
      let testY = agent.y;
      for (let guard = 0; guard < 6; guard += 1) {
        const clash = placed.some((p) => Math.abs(p.x - agent.x) < 40 && Math.abs(p.y - testY) < 12);
        if (!clash) break;
        lift += 12;
        testY = agent.y - lift;
      }
      placed.push({ x: agent.x, y: testY });
      tag.style.left = `${agent.x}px`;
      tag.style.top = `${testY}px`;
    }
  }

  refreshTag(agent) {
    const node = agent.tag;
    if (!node) return;
    // VO2D-F3: aria-label/title/dataset TETAP id asli (QA & selector stabil);
    // hanya teks VISIBLE yang memakai alias lowercase.
    node.setAttribute('aria-label', `${agent.id} — ${statusLabel(agent.kind)}`);
    node.title = `${agent.id} — ${statusLabel(agent.kind)}`;
    node.dataset.agent = agent.id;
    const tag = node.querySelector('.nametag');
    if (tag) {
      tag.className = `nametag ${agent.kind}`;
      // Sinkronkan teks bila display_name baru datang dari polling (tanpa
      // membangun ulang node — posisi/anti-tumpang-tindih tidak di-reset).
      const textNode = [...tag.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
      const label = agentLabel(agent);
      if (textNode) { if (textNode.nodeValue !== label) textNode.nodeValue = label; }
      else tag.appendChild(document.createTextNode(label));
    }
    const dot = node.querySelector('.dot');
    if (dot) dot.className = `dot ${agent.kind}`;
  }

  releaseTags() {
    for (const agent of this.agents) {
      if (agent.tag?.isConnected) agent.tag.remove();
      agent.tag = null;
    }
  }

  setData(profiles, tasks) {
    const prior = new Map(this.agents.map((agent) => [agent.id, agent]));
    this.profiles = profiles;
    this.tasks = tasks;
    this.releaseTags();
    this.agents = profiles.map((profile, i) => {
      const id = profileKey(profile, i);
      const old = prior.get(id);
      const kind = statusKind(profile);
      const task = activeTask(profile, tasks);
      const pose = profilePose(kind);
      if (old) {
        old.profile = profile;
        old.kind = kind;
        old.task = task;
        old.color = pickColor(profile);
        old.error = isUnknownTelemetry(profile);
        old.image = old.image || null;
        // FR-C3: ganti sprite saat pose berubah (idle <-> sit).
        if (old.pose !== pose) {
          old.pose = pose;
          old.breathAt = 0;
          loadSprite(id, pose).then((img) => { if (img && old.pose === pose) old.image = img; });
        }
        // FR-C5: titik status harus ikut berubah warna seiring status.
        old.tag = old.tag || this.makeTag(old);
        this.refreshTag(old);
        // FR-C4: MERAH (telemetry unknown) wajib diam — hentikan langkah yang
        // sedang berjalan; jangan dironda, jangan disuruh pulih ke tujuan.
        if (kind === 'unknown') {
          old.path = [];
          old.walking = false;
        } else if (kind === 'working' && old.deskSlot == null) {
          // Active -> idle settles at a workstation; idle -> active moves to seat.
          const slot = validDeskSlot(profile) ?? (i % DESKS.length);
          old.deskSlot = slot;
          this.moveAgent(old, DESKS[slot].seat);
        } else if (kind !== 'working' && old.deskSlot != null) {
          old.deskSlot = null;
          this.moveAgent(old, choice(ROAM_SPOTS, old.seed * 11 + i));
        }
        return old;
      }
      const deskSlot = kind === 'working' ? (validDeskSlot(profile) ?? i % DESKS.length) : null;
      const start = deskSlot != null ? DESKS[deskSlot].seat : choice(ROAM_SPOTS, i * 7 + 3);
      const [x, y] = cellCenter(start[0], start[1]);
      const agent = { id, profile, kind, task, image: null, x, y, home: start, deskSlot, path: [], segment: 0, walking: false, frame: 0, frameAt: 0, idleAt: 0, nextRoamAt: 700 + (i * 977) % 2800, direction: 'down', color: pickColor(profile), seed: i + 1, error: isUnknownTelemetry(profile), pose, breathAt: 0, tag: null };
      agent.tag = this.makeTag(agent);
      loadSprite(id, pose).then((img) => { if (img && agent.pose === pose) agent.image = img; });
      return agent;
    });
    if (this.raf) this.cancel();
    this.draw();
    if (!this.disposed) this.start();
  }

  moveAgent(agent, target) {
    const [tc, tr] = target;
    const sc = Math.max(0, Math.min(COLS - 1, Math.floor(agent.x / GRID)));
    const sr = Math.max(0, Math.min(ROWS - 1, Math.floor(agent.y / GRID)));
    const goal = nearestFree(tc, tr, this.mask);
    const path = findPath(sc, sr, goal[0], goal[1], this.mask);
    if (path.length < 2) {
      // Already at target or unreachable: still defer the next attempt so we
      // never busy-retry the same spot on every frame (canvas looks frozen).
      agent.nextRoamAt = performance.now() + 1500;
      return false;
    }
    agent.path = path.slice(1).map(([c, r]) => cellCenter(c, r));
    agent.segment = 0;
    agent.walking = true;
    agent.frameAt = 0;
    agent.nextRoamAt = performance.now() + 6000;
    this.ensureRaf();
    return true;
  }

  updateAgent(agent, dt, now) {
    if (agent.walking && agent.segment < agent.path.length) {
      const [tx, ty] = agent.path[agent.segment];
      const dx = tx - agent.x;
      const dy = ty - agent.y;
      const d = Math.hypot(dx, dy);
      if (d < 1) {
        agent.x = tx; agent.y = ty; agent.segment += 1;
        if (agent.segment >= agent.path.length) {
          agent.walking = false; agent.path = []; agent.idleAt = now;
          // FR-C3: kembali ke pose semula (sit untuk hijau, idle untuk kuning)
          // — tanpa ini sprite tetap walk_a/walk_b dan _sit tak pernah tampil.
          loadSprite(agent.id, profilePose(agent.kind)).then((img) => { if (img && !agent.walking) agent.image = img; });
          return;
        }
      } else {
        const step = Math.min(d, SPEED * dt);
        agent.x += (dx / d) * step;
        agent.y += (dy / d) * step;
        agent.direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
        if (now - agent.frameAt >= FRAME_MS) {
          agent.frame = 1 - agent.frame;
          agent.frameAt = now;
          const pose = agent.frame ? 'walk_a' : 'walk_b';
          loadSprite(agent.id, pose).then((img) => { if (img) agent.image = img; });
        }
      }
    } else if (agent.kind === 'available' && !agent.error && now >= agent.nextRoamAt) {
      const [c, r] = choice(ROAM_SPOTS, Math.floor(now / 3000) + agent.seed * 19);
      this.moveAgent(agent, [c, r]);
      agent.nextRoamAt = now + IDLE_REST_MS + (agent.seed % 4) * 850;
    }
  }

  draw() {
    if (this.disposed) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.base) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.base, 0, 0);
    }
    let tagged = 0;
    for (const agent of this.agents) {
      const image = agent.image;
      // pixel-perfect nearest-neighbor; char assets are native 13-19x21-24.
      if (image) {
        const w = image.width, h = image.height;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(image, Math.round(agent.x - w / 2), Math.round(agent.y - h + 4));
      } else {
        ctx.fillStyle = agent.color;
        ctx.fillRect(Math.round(agent.x - 6), Math.round(agent.y - 20), 12, 18);
      }
      // FR-C5: titik status ada di tag DOM; kotak canvas hanya fallback bila
      // layer tag gagal dibuat (mis. canvas tanpa parent).
      if (agent.tag) tagged += 1;
      else {
        ctx.fillStyle = agent.color;
        ctx.strokeStyle = '#2b2118'; ctx.lineWidth = 1;
        ctx.fillRect(Math.round(agent.x + 6), Math.round(agent.y - 21), 5, 5);
        ctx.strokeRect(Math.round(agent.x + 6), Math.round(agent.y - 21), 5, 5);
      }
    }
    if (tagged) this.syncTags();
  }

  tick = (ts) => {
    if (this.disposed) return;
    const dt = this.lastTs ? Math.min((ts - this.lastTs) / 1000, MAX_DELTA) : 0;
    this.lastTs = ts;
    let moving = false;
    for (const agent of this.agents) {
      this.updateAgent(agent, dt, ts);
      if (agent.walking || (agent.kind === 'available' && !agent.error)) moving = true;
    }
    this.draw();
    if (moving) this.raf = requestAnimationFrame(this.tick);
    else this.raf = 0;
  };

  ensureRaf() {
    if (!this.raf && !this.disposed) {
      this.lastTs = 0;
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  cancel() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  start() { this.ensureRaf(); }

  dispose() {
    this.disposed = true;
    this.cancel();
    this.releaseTags();
  }
}

export { SPRITE_SIZE };
