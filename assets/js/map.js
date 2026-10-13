// map.js — definisi peta: grid 32px, 4 zonasi, dinding, pintu, workstation,
// titik roaming. Semua koordinat dalam CEL (cell index) lalu dikalikan GRID=32.
//
// REDESIGN OPSI C (DESIGN_REDESIGN_UIUX.md): world 33 x 17 cell = 1056 x 544 px.
// 4 room PNG ditempel NATIVE 1x per zona (margin cell diserap ke interior art);
// collision grid TETAP 32px cell (pathfinding.js tidak diubah).
//
//      0   1         12 13 14 15 16 17         31 32
//   0  +---------------+--+-----+--+---------------+
//      | CAFETERIA 12x7|  |CORR |  | MEETING ROOM   |  rows 1..7
//      |  (roaming)    |  | 2c  |  | (EXCLUSION)    |
//   8  +---------------+D-+--D--+D-+---------------+  row 8 = partisi H
//      | MAIN OFFICE   |  |     |  | LOUNGE         |  rows 9..15
//      | (workstation) |  |     |  |  (roaming)     |
//   16 +---------------+--+-----+--+---------------+
//
// Zona: cafeteria 12x7, main 12x7, meeting 15x7 (exclude), lounge 15x7,
// koridor cols 14-15 (terbuka penuh dari row 1..15, penghubung atas-bawah).

export const GRID = 32;
export const COLS = 33;
export const ROWS = 17;
export const WORLD_W = COLS * GRID; // 1056
export const WORLD_H = ROWS * GRID; // 544

export const ZONES = {
  cafeteria: { name: 'CAFETERIA', c0: 1, r0: 1, c1: 12, r1: 7, roam: true },
  meeting: { name: 'MEETING ROOM', c0: 17, r0: 1, c1: 31, r1: 7, roam: false, excluded: true },
  main: { name: 'MAIN OFFICE', c0: 1, r0: 9, c1: 12, r1: 15, roam: false },
  lounge: { name: 'LOUNGE', c0: 17, r0: 9, c1: 31, r1: 15, roam: true },
  corridor: { name: 'CORRIDOR', c0: 14, r0: 1, c1: 15, r1: 15, roam: false },
};

// Pintu (cell yang menembus partisi). Meeting door sengaja ditandai excluded
// supaya mask KUNING tidak pernah menembus ke Meeting Room.
export const DOORS = [
  { c: 13, r: 3, zone: 'cafeteria' },
  { c: 16, r: 3, zone: 'meeting', excluded: true },
  { c: 13, r: 11, zone: 'main' },
  { c: 16, r: 11, zone: 'lounge' },
];

// Partisi internal: vertikal memisahkan ruang dari koridor; horizontal row 8
// (dengan celah terbuka hanya di koridor col 14-15).
const PARTITION_V = [13, 16];
const CORRIDOR_COLS = [14, 15];
const PARTITION_H = [8];
const MEETING_DOOR = { c: 16, r: 3 }; // satu-satunya pintu ke meeting (selalu ditutup utk avatar)

export const idx = (c, r) => r * COLS + c;
export const cellCenter = (c, r) => [c * GRID + GRID / 2, r * GRID + GRID / 2];
export const pxToCell = (x, y) => [
  Math.max(0, Math.min(COLS - 1, Math.floor(x / GRID))),
  Math.max(0, Math.min(ROWS - 1, Math.floor(y / GRID))),
];

function isWallCell(c, r) {
  if (c === 0 || c === COLS - 1 || r === 0 || r === ROWS - 1) return true;
  if (PARTITION_V.includes(c)) return true;
  if (PARTITION_H.includes(r) && !CORRIDOR_COLS.includes(c)) return true;
  return false;
}

const doorAt = (c, r) => DOORS.some((d) => d.c === c && d.r === r);

/** Workstation: 13 slot di Main Office (FROZEN_ORDER 13 entry, 11 profil).
 *  desk cell = furniture (terblokir), seat cell = tempat avatar duduk (bebas).
 *  Layout sementara 8 + 4 + 1; posisi presisi terhadap kursi baked room PNG
 *  disesuaikan kartu R2 memakai peta okupansi hasil analisis worker. */
function buildDesks() {
  const desks = [];
  // Blok A: 8 kursi (kursi baked main_office)
  for (let c = 2; c <= 9; c += 1) desks.push({ desk: [c, 10], seat: [c, 11] });
  // Blok B: 4 kursi (cubicle_row_4seat)
  for (let c = 2; c <= 5; c += 1) desks.push({ desk: [c, 13], seat: [c, 14] });
  // Slot 13: standing pos (tanpa meja ekstra)
  desks.push({ desk: [10, 13], seat: [10, 14] });
  return desks;
}
export const DESKS = buildDesks();


/** Furnitur dekoratif (gambar saja, tidak menghalangi) + blockers tersendiri.
 *  Posisi DISESUAIKAN geometri baru; kartu R2 mengganti dengan room PNG native. */
export const PROPS = [
  // Cafeteria (cols 1-12, rows 1-7)
  { asset: 'counter_grey', c: 1, r: 1, w: 3 },
  { asset: 'coffee_machine', c: 5, r: 1, w: 1 },
  { asset: 'vending', c: 9, r: 1, w: 1 },
  { asset: 'table', c: 4, r: 3, w: 2 },
  { asset: 'table', c: 8, r: 5, w: 2 },
  { asset: 'chair_blue', c: 3, r: 4, w: 1 },
  { asset: 'chair_blue', c: 10, r: 3, w: 1 },
  // Meeting Room (cols 17-31, rows 1-7)
  { asset: 'meeting_table', c: 20, r: 2, w: 4 },
  { asset: 'chair_red', c: 19, r: 3, w: 1 },
  { asset: 'chair_red', c: 25, r: 3, w: 1 },
  { asset: 'whiteboard', c: 24, r: 1, w: 1 },
  // Main Office (cols 1-12, rows 9-15) — meja digambar dari DESKS
  { asset: 'shelf', c: 9, r: 9, w: 1 },
  { asset: 'printer', c: 9, r: 12, w: 1 },
  { asset: 'plant', c: 1, r: 15, w: 1 },
  // Lounge (cols 17-31, rows 9-15)
  { asset: 'sofa', c: 18, r: 9, w: 3 },
  { asset: 'couch_orange', c: 24, r: 13, w: 2 },
  { asset: 'shelf', c: 30, r: 9, w: 1 },
  { asset: 'plant', c: 17, r: 15, w: 1 },
];

/** Sel yang diblokir furnitur besar agar avatar tidak menembus.
 *  Dideklarasikan SEBELUM buildRoamSpots agar spot bisa difilter. */
const PROP_BLOCK = [
  [4, 3], [5, 3], // meja cafeteria
  [8, 5], [9, 5], // meja cafeteria 2
  [20, 2], [21, 2], [22, 2], [23, 2], // meja meeting (zona exclude)
  [18, 9], [19, 9], [20, 9], // sofa lounge
  [24, 13], [25, 13], // couch lounge
  // DESK CELLS — meja baked furnitur di Main Office (wajib terblokir)
  [2, 10], [3, 10], [4, 10], [5, 10], [6, 10], [7, 10], [8, 10], [9, 10], // blok A (8 meja)
  [2, 13], [3, 13], [4, 13], [5, 13], // blok B (cubicle_row_4seat, 4 meja)
  [10, 13], // standing pos (slot 13)
];

/** Titik roaming KUNING: Cafeteria + Lounge (checkerboard) + koridor penghubung.
 *  Spot yang jatuh di cell furnitur terblokir (PROP_BLOCK) dibuang supaya tidak
 *  ada target roaming yang tidak terjangkau (A* gagal -> avatar diam). */
function buildRoamSpots() {
  const spots = [];
  const blocked = new Set(PROP_BLOCK.map(([c, r]) => `${c},${r}`));
  const push = (c, r) => {
    if (!blocked.has(`${c},${r}`)) spots.push([c, r]);
  };
  for (const key of ['cafeteria', 'lounge']) {
    const z = ZONES[key];
    for (let r = z.r0; r <= z.r1; r += 1) {
      for (let c = z.c0; c <= z.c1; c += 1) {
        if ((c + r) % 2 === 0) push(c, r);
      }
    }
  }
  // Koridor sebagai penghubung atas-bawah (semua sel koridor selalu walkable)
  for (let r = ZONES.corridor.r0; r <= ZONES.corridor.r1; r += 1) {
    for (const c of CORRIDOR_COLS) push(c, r);
  }
  return spots;
}
export const ROAM_SPOTS = buildRoamSpots();

/**
 * Bangun mask jalan. mode:
 *   'all'     → semua ruang kecuali Meeting Room (dipakai KUNING & HIJAU)
 *   'meeting' → hanya Meeting Room (tak pernah dipakai avatar)
 * Semua sel ditandai Uint8Array(1=terblokir).
 */
export function buildWalkMask({ excludeMeeting = true } = {}) {
  const mask = new Uint8Array(COLS * ROWS);
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      let blocked = isWallCell(c, r);
      if (blocked && doorAt(c, r) && !(excludeMeeting && c === MEETING_DOOR.c && r === MEETING_DOOR.r)) {
        blocked = false;
      }
      if (excludeMeeting) {
        const m = ZONES.meeting;
        if (c >= m.c0 && c <= m.c1 && r >= m.r0 && r <= m.r1) blocked = true;
        if (c === MEETING_DOOR.c && r === MEETING_DOOR.r) blocked = true; // pintu meeting ditutup utk kuning
      }
      if (PROP_BLOCK.some(([pc, pr]) => pc === c && pr === r)) blocked = true;
      mask[idx(c, r)] = blocked ? 1 : 0;
    }
  }
  return mask;
}

/** Zona dari posisi cell — dipakai untuk menentukan label & validasi roaming. */
export function zoneAt(c, r) {
  for (const [key, z] of Object.entries(ZONES)) {
    if (c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1) return key;
  }
  return 'corridor';
}
