// pathfinding.js — A* 4-neighbor di atas mask grid 32px.
// 4-neighbor (tanpa diagonal) supaya path tidak memotong sudut partisi.

import { COLS, ROWS, idx, cellCenter } from './map.js';

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Min-heap kecil (binary) — open list tidak diurut ulang tiap iterasi. */
class MinHeap {
  constructor() {
    this.a = [];
  }
  push(node) {
    this.a.push(node);
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[p][0] <= this.a[i][0]) break;
      [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
      i = p;
    }
  }
  pop() {
    if (this.a.length === 0) return null;
    const top = this.a[0];
    const last = this.a.pop();
    if (this.a.length > 0) {
      this.a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.a.length && this.a[l][0] < this.a[m][0]) m = l;
        if (r < this.a.length && this.a[r][0] < this.a[m][0]) m = r;
        if (m === i) break;
        [this.a[m], this.a[i]] = [this.a[i], this.a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

/**
 * Cari jalur [ [c,r], ... ] dari sel start ke sel goal.
 * @returns {Array} daftar sel (termasuk start & goal) atau [] bila tak terjangkau.
 */
export function findPath(startC, startR, goalC, goalR, mask) {
  const s = idx(startC, startR);
  const t = idx(goalC, goalR);
  if (s === t) return [[startC, startR]];
  if (mask[t]) return []; // target terblokir → tidak mungkin

  const N = COLS * ROWS;
  const came = new Int32Array(N).fill(-1);
  const g = new Float32Array(N).fill(Infinity);
  const closed = new Uint8Array(N);

  const h = (c, r) => Math.abs(c - goalC) + Math.abs(r - goalR);
  g[s] = 0;
  const open = new MinHeap();
  open.push([h(startC, startR), s]);

  while (open.size > 0) {
    const [, cur] = open.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === t) {
      const out = [];
      let node = cur;
      while (node !== -1) {
        out.push([node % COLS, Math.floor(node / COLS)]);
        node = came[node];
      }
      out.reverse();
      return out;
    }
    const c = cur % COLS;
    const r = Math.floor(cur / COLS);
    for (const [dc, dr] of DIRS) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
      const ni = idx(nc, nr);
      if (mask[ni]) continue;
      const ng = g[cur] + 1;
      if (ng < g[ni]) {
        g[ni] = ng;
        came[ni] = cur;
        open.push([ng + h(nc, nr), ni]);
      }
    }
  }
  return [];
}

/** Konversi jalur sel → posisi pixel tengah sel (untuk konsumsi animator). */
export function pathToPixels(cells) {
  return cells.map(([c, r]) => cellCenter(c, r));
}

/** Cari sel terdekat yang tidak terblokir (fallback saat tujuan kena blokir). */
export function nearestFree(c, r, mask) {
  if (!mask[idx(c, r)]) return [c, r];
  for (let radius = 1; radius < Math.max(COLS, ROWS); radius += 1) {
    for (let dc = -radius; dc <= radius; dc += 1) {
      for (let dr = -radius; dr <= radius; dr += 1) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== radius) continue;
        const nc = c + dc;
        const nr = r + dr;
        if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
        if (!mask[idx(nc, nr)]) return [nc, nr];
      }
    }
  }
  return [c, r];
}
