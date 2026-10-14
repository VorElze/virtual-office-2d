// auth.js — VO-OFFICE-R1: overlay registrasi pertama / login wajib.
//
// Kontrak server (lihat server.py :: /api/auth/*):
//   GET  api/auth/status -> {auth_required, authenticated, user, mode}  (public)
//   POST api/auth/register -> 200 saat BELUM ada user; 403 register_closed
//   POST api/auth/login    -> 200 + Set-Cookie HttpOnly; 401/429 bila gagal
//   POST api/auth/logout   -> 200 + hapus cookie
//
// Cookie session HttpOnly sehingga JS TIDAK bisa membacanya — cukup pantau
// 401 dari endpoint data (fetchAuthStatus / updateOffice / updateChat).
// Semua path relatif (tanpa leading slash) supaya tetap benar di belakang
// prefix /office (Apache ProxyPass) maupun di port 8765 polos.

import { fetchAuthStatus, login, register, logout } from './api.js';

const $ = (id) => document.getElementById(id);

// VO-INVITE: token undangan dari URL (?invite=...). Dikirim saat register —
// server memvalidasi & menandai sekali pakai. Setelah sukses, URL dibersihkan
// supaya token tidak tertinggal di history/address bar.
const INVITE = new URLSearchParams(window.location.search).get('invite');

let modal;
let loginForm;
let registerForm;
let errorEl;
let subtitleEl;
let noteEl;
let resolveGate = null;      // resolver proses init (main.js bootstrap)
let authenticated = false;
let lastMode = '';

function show(text) {
  if (!errorEl) return;
  errorEl.hidden = !text;
  errorEl.textContent = text || '';
}

function setMode(mode) {
  lastMode = mode;
  modal.dataset.mode = mode;
  const isRegister = mode === 'register';
  loginForm.hidden = isRegister;
  registerForm.hidden = !isRegister;
  subtitleEl.textContent = isRegister
    ? 'buat akun pertama — registrasi ditutup sesudahnya'
    : (INVITE ? 'punya link undangan? daftar di sini' : 'masuk dengan akun yang sudah terdaftar');
  noteEl.textContent = isRegister
    ? (INVITE ? 'Undangan sekali pakai — satu link hanya untuk satu akun.' : '')
    : (INVITE ? 'Undangan aktif: daftar akun baru lewat tombol di bawah.' : 'Akun baru hanya bisa ditambahkan dari server.');
  if (!isRegister && INVITE) {
    // tautan cepat ke form registrasi saat link undangan dibawa
    noteEl.innerHTML = '<button type="button" class="retro-button" id="authSwitchRegister">Daftar dengan undangan</button>';
    $('authSwitchRegister')?.addEventListener('click', () => open('register'));
  }
  show('');
}

function open(mode) {
  setMode(mode);
  modal.hidden = false;
  document.body.classList.add('auth-lock');
  const first = (mode === 'register' ? $('authRegUser') : $('authLoginUser'));
  window.setTimeout(() => first?.focus(), 30);
}

function close() {
  modal.hidden = true;
  document.body.classList.remove('auth-lock');
  modal.dataset.mode = '';
}

function settle(ok, mode) {
  if (!resolveGate) return;
  const resolve = resolveGate;
  resolveGate = null;
  if (ok) { authenticated = true; close(); }
  else { open(mode); }
  resolve(ok);
}

async function submit(kind) {
  show('');
  let result;
  if (kind === 'register') {
    const username = $('authRegUser').value.trim();
    const password = $('authRegPass').value;
    const confirm = $('authRegPass2').value;
    if (password !== confirm) { show('Konfirmasi password tidak sama.'); return; }
    if (password.length < 8) { show('Password minimal 8 karakter.'); return; }
    if (!/^[A-Za-z0-9_.\-]{3,32}$/.test(username)) {
      show('Username: 3-32 karakter, hanya [A-Za-z0-9_.-].');
      return;
    }
    result = await register(username, password, confirm, INVITE);
  } else {
    const username = $('authLoginUser').value.trim();
    const password = $('authLoginPass').value;
    if (!username || !password) { show('Username dan password wajib diisi.'); return; }
    result = await login(username, password);
  }

  if (result.ok) {
    // Registrasi kedua yang keburu menang (race) tetap balas 403 register_closed
    // — tangani di cabang error di bawah.
    settle(true);
    // Bersihkan token undangan dari URL (sudah terpakai) sebelum reload.
    window.history.replaceState({}, '', window.location.pathname);
    window.location.reload();   // muat ulang supaya state aplikasi bersih
    return;
  }
  if (result.httpStatus === 403 && result.data?.error === 'register_closed') {
    // akun sudah ada -> pindah ke form login
    setMode('login');
    show('Registrasi sudah ditutup. Silakan masuk.');
    return;
  }
  if (result.httpStatus === 403 && INVITE) {
    show('Link undangan tidak valid / sudah terpakai. Minta link baru.');
    return;
  }
  if (result.httpStatus === 429) {
    show(result.error || 'Terlalu banyak percobaan gagal. Coba lagi nanti.');
    return;
  }
  show(result.error || (result.offline ? 'Koneksi gagal — cek jaringan.' : 'Gagal. Coba lagi.'));
}

/** Init: panggil SEBELUM bootstrap app. true = boleh lanjut; false = menunggu login. */
export function initAuth() {
  modal = $('authModal');
  loginForm = $('authLoginForm');
  registerForm = $('authRegisterForm');
  errorEl = $('authError');
  subtitleEl = $('authSubtitle');
  noteEl = $('authNote');
  if (!modal) return Promise.resolve(true);

  loginForm.addEventListener('submit', (event) => { event.preventDefault(); submit('login'); });
  registerForm.addEventListener('submit', (event) => { event.preventDefault(); submit('register'); });
  // backdrop & Escape: tidak bisa menutup bila belum login (tanpa itu halaman kosong)
  modal.addEventListener('click', (event) => {
    if (event.target?.dataset.backdrop && authenticated) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden && authenticated) close();
  });

  return (async () => {
    const status = await fetchAuthStatus();
    if (!status.ok || !status.data) {
      // server tidak menjawab / status rusak -> biarkan app jalan (mode lama)
      console.warn('[auth] status tidak tersedia:', status.error);
      return true;
    }
    if (!status.data.auth_required) return true;          // auth belum aktif
    if (status.data.authenticated) return true;           // sudah login
    // VO-INVITE: link undangan -> langsung buka form registrasi (bukan login)
    const mode = (status.data.mode === 'register' || INVITE) ? 'register' : 'login';
    return new Promise((resolve) => { resolveGate = resolve; open(mode); });
  })();
}

/** Dipanggil dari main.js saat endpoint data membalas 401. */
export function onUnauthorized() {
  if (!modal || !modal.hidden) return;
  authenticated = false;
  open(lastMode === 'register' ? 'register' : 'login');
}

export function isAuthenticated() { return authenticated; }

/** Logout via tombol di topbar (dipasang main.js). */
export async function doLogout() {
  await logout();
  window.location.reload();
}
