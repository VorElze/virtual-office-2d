// api.js — lapisan akses endpoint RELATIF (tanpa hostname, tanpa leading slash)
// supaya tidak kena NET::ERR_CERT_AUTHORITY_INVALID saat dibuka lewat reverse
// proxy / self-signed, DAN tetap benar di belakang prefix /office.
// Contract /api/office dan /api/chat TIDAK diubah (hanya cara menulis path).

const OFFICE_PATH = 'api/office';
const CHAT_PATH = 'api/chat';
const AUTH_STATUS_PATH = 'api/auth/status';
const AUTH_LOGIN_PATH = 'api/auth/login';
const AUTH_REGISTER_PATH = 'api/auth/register';
const AUTH_LOGOUT_PATH = 'api/auth/logout';

async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { cache: 'no-store', ...options });
  } catch (error) {
    return { ok: false, offline: true, error: String(error?.message || error) };
  }
  let data = null;
  let parseError = null;
  try {
    data = await response.json();
  } catch (error) {
    parseError = `payload rusak: ${String(error?.message || error)}`;
  }
  if (!response.ok) {
    // VO-OFFICE-R1: bawa payload error server (mis. {error, detail}) supaya
    // UI bisa menampilkan pesan sebenarnya, bukan sekadar "HTTP 401".
    return { ok: false, httpStatus: response.status, data,
             error: (data && (data.detail || data.error)) || `HTTP ${response.status}` };
  }
  if (parseError || data === null) {
    return { ok: false, error: parseError || 'payload kosong' };
  }
  return { ok: true, data };
}

export async function fetchOffice() {
  const result = await request(OFFICE_PATH);
  if (!result.ok) return result;
  // Normalisasi minimal: field wajib ada sebagai array agar render tidak melempar.
  const data = result.data || {};
  return {
    ok: true,
    data: {
      ...data,
      profiles: Array.isArray(data.profiles) ? data.profiles : [],
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      recent: Array.isArray(data.recent) ? data.recent : [],
    },
  };
}

export async function fetchChat() {
  const result = await request(CHAT_PATH);
  if (!result.ok) return result;
  const data = result.data || {};
  return {
    ok: true,
    data: {
      ...data,
      messages: Array.isArray(data.messages) ? data.messages : [],
      group_states: data.group_states && typeof data.group_states === 'object' ? data.group_states : {},
    },
  };
}

export async function sendChat({ text, targetProfile, clientMessageId, csrf }) {
  const body = JSON.stringify({
    text,
    target_profile: targetProfile,
    client_message_id: clientMessageId,
  });
  const result = await request(CHAT_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Office-Csrf': csrf || '' },
    body,
  });
  if (!result.ok) return result;
  return { ok: true, data: result.data };
}

/* ================= VO-OFFICE-R1: auth =================
   Status selalu bisa di-GET (public). Register/login/logout hanya bila auth
   aktif. Server menaruh cookie HttpOnly — JS tidak (dan tidak bisa) membaca
   token; cukup pantau 401 pada endpoint data. */

export async function fetchAuthStatus() {
  return request(AUTH_STATUS_PATH);
}

async function authPost(url, payload) {
  const result = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  // request() melempar {ok:false, httpStatus}; tambahkan payload error utk pesan user.
  if (!result.ok && result.httpStatus) {
    return { ...result, data: result.data || null };
  }
  return result;
}

export async function login(username, password) {
  return authPost(AUTH_LOGIN_PATH, { username, password });
}

export async function register(username, password, confirm, invite) {
  const payload = { username, password, confirm };
  if (invite) payload.invite = invite;
  return authPost(AUTH_REGISTER_PATH, payload);
}

export async function logout() {
  return request(AUTH_LOGOUT_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
}

