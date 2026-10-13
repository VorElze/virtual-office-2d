// render.js — komposisi room pixel-art pada ukuran native 1x.
import { GRID, COLS, ROWS, ZONES } from './map.js';

const ROOT = '/assets/office';
const cache = new Map();
const ROOM_FILES = {
  cafeteria: `${ROOT}/rooms/room_cafeteria.png`,
  main: `${ROOT}/rooms/room_main_office.png`,
  meeting: `${ROOT}/rooms/room_meeting_room.png`,
  lounge: `${ROOT}/rooms/room_lounge.png`,
};
const SPRITE_FILES = {
  cubicle_row_4seat: `${ROOT}/sprites/cubicle_row_4seat.png`,
};
const ASSET_FILES = { ...ROOM_FILES, ...SPRITE_FILES };

function getAsset(key) {
  const src = ASSET_FILES[key];
  if (!src) throw new Error(`[render] aset tidak dikenal: ${key}`);
  if (!cache.has(key)) {
    const img = new Image();
    img.src = src;
    cache.set(key, img);
  }
  return cache.get(key);
}

export async function loadAssets() {
  await Promise.all(Object.keys(ASSET_FILES).map((key) => new Promise((resolve, reject) => {
    const img = getAsset(key);
    if (img.complete) {
      if (img.naturalWidth) resolve();
      else reject(new Error(`[render] gagal memuat ${ASSET_FILES[key]}`));
      return;
    }
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`[render] gagal memuat ${ASSET_FILES[key]}`));
  })));
}

function drawNative(ctx, img, x, y) {
  if (!img?.complete || !img.naturalWidth) throw new Error('[render] aset belum siap');
  // Tanpa destination width/height: browser menggambar persis ukuran source 1x.
  ctx.drawImage(img, Math.round(x), Math.round(y));
}

function roomOrigin(key, img) {
  const z = ZONES[key];
  const x = z.c0 * GRID;
  const y = z.r0 * GRID;
  const w = (z.c1 - z.c0 + 1) * GRID;
  const h = (z.r1 - z.r0 + 1) * GRID;
  return [Math.round(x + (w - img.naturalWidth) / 2), Math.round(y + (h - img.naturalHeight) / 2)];
}

function drawRooms(ctx) {
  for (const key of ['cafeteria', 'main', 'meeting', 'lounge']) {
    const img = getAsset(key);
    const [x, y] = roomOrigin(key, img);
    drawNative(ctx, img, x, y);
  }
}

function drawCubicleRow(ctx) {
  const img = getAsset('cubicle_row_4seat');
  // Selaras dengan slot desk c=2..5, seat row=14 pada map.js.
  drawNative(ctx, img, 2 * GRID, 13 * GRID - 26);
}

export function renderBase(ctx) {
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, COLS * GRID, ROWS * GRID);
  drawRooms(ctx);
  // Furniture yang sudah tercetak pada room PNG tidak digambar ulang.
  drawCubicleRow(ctx);
}
