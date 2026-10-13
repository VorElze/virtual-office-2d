// api.js — lapisan akses endpoint RELATIF (tanpa hostname) supaya tidak kena
// NET::ERR_CERT_AUTHORITY_INVALID saat dibuka lewat reverse proxy / self-signed.
// Contract /api/office dan /api/chat TIDAK diubah.

const OFFICE_PATH = '/api/office';
const CHAT_PATH = '/api/chat';

async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { cache: 'no-store', ...options });
  } catch (error) {
    return { ok: false, offline: true, error: String(error?.message || error) };
  }
  if (!response.ok) {
    return { ok: false, httpStatus: response.status, error: `HTTP ${response.status}` };
  }
  try {
    return { ok: true, data: await response.json() };
  } catch (error) {
    return { ok: false, error: `payload rusak: ${String(error?.message || error)}` };
  }
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
