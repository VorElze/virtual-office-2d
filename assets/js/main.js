// main.js — boot, API polling, canvas base render, UI, chat, zoom/workspace toggle.
// Endpoints tetap relative di api.js; tidak ada server/API change.

import { fetchOffice, fetchChat, sendChat } from './api.js';
import { OfficeAnimator, agentLabel } from './animation.js';
import { WORLD_W, WORLD_H, GRID, ZONES } from './map.js';
import { renderBase, loadAssets } from './render.js';

const POLL_MS = 5000;
const CHAT_POLL_MS = 4000;
const $ = (id) => document.getElementById(id);
const ui = {
  canvas: $('officeCanvas'), viewport: $('mapViewport'), wrap: $('canvasWrap'),
  profileCount: $('profileCount'), workingCount: $('workingCount'), taskCount: $('taskCount'), runtimeStatus: $('runtimeStatus'),
  connectionLed: $('connectionLed'), connectionText: $('connectionText'), updated: $('updated'),
  taskList: $('taskList'), taskFilter: $('taskFilter'), activityList: $('activityList'),
  chatMessages: $('chatMessages'), chatForm: $('chatForm'), chatInput: $('chatInput'), chatTarget: $('chatTarget'),
  profileRoster: $('profileRoster'), profileRosterToggle: $('profileRosterToggle'),
  refreshButton: $('refreshButton'), workspaceButton: $('workspaceButton'), zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomReset: $('zoomReset'),
  dialog: $('profileDialog'), profileDetail: $('profileDetail'), toast: $('toast'),
  // VO2D-F3: modal Kanban Task-Manager (id sendiri, tidak menyentuh #profileDialog)
  kanbanModal: $('kanbanModal'), kanbanClose: $('kanbanClose'),
  kanbanFilters: $('kanbanFilters'), kanbanColumns: $('kanbanColumns'),
  kanbanBoardMeta: $('kanbanBoardMeta'),
};

let office = { profiles: [], tasks: [], recent: [], groups: [], profiles_detail: [] };
let animator = null;
let zoom = 1;
let workspaceSnapshot = null;
let toastTimer = 0;
let csrfToken = '';
let officeTimer = 0;
let chatTimer = 0;
let lastMessageIds = new Set();
let selectedTarget = 'all';
let previousChatHeight = 0;
let rosterOpen = false;      // VO2D-F2: state panel daftar profil (aria-expanded)
let rosterSignature = '';    // VO2D-F2: hindari innerHTML ulang tiap poll 5s

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
function safeDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}
function shortTime(value) {
  const date = safeDate(value);
  return date ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
}
function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.style.display = 'none'; }, 2600);
}
function setConnection(ok, text) {
  ui.connectionText.textContent = text;
  ui.connectionLed.style.background = ok ? '#37a86c' : '#dd5360';
}
function profileName(profile) {
  return profile?.profile || profile?.name || profile?.id || 'unknown';
}
function activeCount(profiles) {
  return profiles.filter((p) => p?.working === true).length;
}
function taskStatus(task) {
  const status = String(task?.status || 'unknown').toLowerCase();
  if (['running', 'ready', 'blocked', 'done'].includes(status)) return status;
  return 'unknown';
}
function normalizeTasks(data) {
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  return tasks.map((task) => ({ ...task, status: taskStatus(task) }));
}
function updateStats(data) {
  ui.profileCount.textContent = String(data.profiles.length);
  ui.workingCount.textContent = String(activeCount(data.profiles));
  const active = data.tasks.filter((t) => ['running', 'ready', 'blocked'].includes(t.status)).length;
  ui.taskCount.textContent = String(active);
  ui.runtimeStatus.textContent = data.runtime_status || data.status || 'LIVE';
}

function renderTasks() {
  const filter = ui.taskFilter.value;
  const tasks = office.tasks.filter((t) => filter === 'all' || t.status === filter);
  if (!tasks.length) { ui.taskList.innerHTML = '<div class="empty">Tidak ada kartu sesuai filter.</div>'; return; }
  ui.taskList.innerHTML = tasks.slice(0, 30).map((t) => {
    const title = escapeHtml(t.title || t.name || t.id || 'Untitled task');
    const owner = escapeHtml(t.assignee || t.profile || t.owner || 'unassigned');
    const id = escapeHtml(t.id || '');
    const status = t.status;
    const project = t.project ? ` · ${escapeHtml(t.project)}` : '';
    return `<div class="task"><div class="task-top"><span class="task-title">${title}</span><span class="badge ${status}">${escapeHtml(status)}</span></div><div class="task-meta">${owner}${project}${id ? ` · #${id}` : ''}</div></div>`;
  }).join('');
}

/* ================= VO2D-F3: modal Kanban Task-Manager =================
   Dibuka dari klik/tap papan tulis Meeting Room (animation.js -> onWhiteboardClick).
   id #kanbanModal TERPISAH dari #profileDialog — dialog profile tidak disentuh.
   Z-index: 40 (di atas kanvas/backdrop, di bawah #toast yang 50). */
const KANBAN_STATUSES = ['ready', 'running', 'blocked', 'done', 'unknown'];
const KANBAN_LABELS = { ready: 'Ready', running: 'Running', blocked: 'Blocked', done: 'Done', unknown: 'Lainnya' };
let kanbanFilter = 'all';
let kanbanBodyOverflow = '';

function kanbanTasks() {
  // Normalisasi task live F3 sudah menyamakan status ke ready/running/blocked/
  // done. Tetap tampilkan SEMUA task: backend mungkin menambahkan status lain
  // (mis. archived/cancelled) sebelum client diperbarui; pindahkan ke "Lainnya".
  return (Array.isArray(office.tasks) ? office.tasks : []).filter((t) => t && typeof t === 'object');
}

function kanbanStatus(task) {
  return KANBAN_STATUSES.includes(task.status) ? task.status : 'unknown';
}

function renderKanban() {
  if (!ui.kanbanColumns || !ui.kanbanFilters) return;
  const tasks = kanbanTasks();
  // Badge per status (termasuk saat filter "Semua" — tetap tampil sebagai pilihan).
  const counts = Object.fromEntries(KANBAN_STATUSES.map((s) => [s, tasks.filter((t) => kanbanStatus(t) === s).length]));
  ui.kanbanFilters.innerHTML = [{ key: 'all', label: 'Semua', n: tasks.length }]
    .concat(KANBAN_STATUSES.map((s) => ({ key: s, label: KANBAN_LABELS[s], n: counts[s] })))
    .map((f) => `<button type="button" class="kanban-filter${kanbanFilter === f.key ? ' active' : ''}" data-status="${f.key}" aria-pressed="${kanbanFilter === f.key}">${escapeHtml(f.label)}<span class="badge ${f.key}">${f.n}</span></button>`).join('');
  const shown = tasks.filter((t) => kanbanFilter === 'all' || kanbanStatus(t) === kanbanFilter);
  const groups = KANBAN_STATUSES
    .map((s) => ({ status: s, list: shown.filter((t) => kanbanStatus(t) === s) }))
    .filter((g) => g.list.length);
  if (!groups.length) {
    ui.kanbanColumns.innerHTML = '<div class="empty">Tidak ada kartu sesuai filter.</div>';
  } else {
    ui.kanbanColumns.innerHTML = groups.map((g) => `
      <section class="kanban-col" aria-label="${escapeHtml(KANBAN_LABELS[g.status])}">
        <h3 class="kanban-col-head"><span class="badge ${g.status}">${escapeHtml(KANBAN_LABELS[g.status])}</span><span class="kanban-count">${g.list.length}</span></h3>
        ${g.list.map((t) => {
          const title = escapeHtml(t.title || t.name || t.id || 'Untitled task');
          const owner = escapeHtml(t.assignee_name || t.assignee || t.profile || t.owner || 'unassigned');
          const id = escapeHtml(t.id || '');
          const board = t.board ? `<span class="kanban-board">${escapeHtml(t.board)}</span>` : '';
          return `<article class="task"><div class="task-top"><span class="task-title">${title}</span><span class="badge ${kanbanStatus(t)}">${escapeHtml(t.status || 'unknown')}</span></div><div class="task-meta">${owner}${board}${id ? ` · #${id}` : ''}</div></article>`;
        }).join('')}
      </section>`).join('');
  }
  if (ui.kanbanBoardMeta) {
    const boards = [...new Set(tasks.map((t) => t.board).filter(Boolean))];
    ui.kanbanBoardMeta.textContent = `${tasks.length} kartu${boards.length ? ` · board: ${boards.join(', ')}` : ''}`;
  }
}

function openKanbanModal() {
  const modal = ui.kanbanModal;
  if (!modal || modal.dataset.open === 'true') return;
  // Tutup drawer profile bila terbuka supaya tidak dua overlay bertumpuk.
  if (ui.dialog?.open) ui.dialog.close();
  kanbanFilter = 'all';
  renderKanban();
  kanbanBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden'; // kunci scroll body saat terbuka
  modal.hidden = false;
  modal.dataset.open = 'true';
  ui.kanbanClose?.focus();
}

function closeKanbanModal() {
  const modal = ui.kanbanModal;
  if (!modal || modal.dataset.open !== 'true') return;
  modal.hidden = true;
  modal.dataset.open = 'false';
  document.body.style.overflow = kanbanBodyOverflow; // pulihkan scroll body
  // Kembalikan fokus ke kanvas agar keyboard user tidak hilang konteks.
  ui.canvas?.focus?.();
}

function installKanbanModal() {
  const modal = ui.kanbanModal;
  if (!modal) return;
  ui.kanbanClose?.addEventListener('click', closeKanbanModal);
  // Klik backdrop (elemen .kanban-backdrop di luar panel) menutup.
  modal.addEventListener('click', (event) => {
    if (event.target.classList?.contains('kanban-backdrop')) closeKanbanModal();
  });
  // Filter status (delegasi — tombol dirender ulang tiap update data).
  ui.kanbanFilters?.addEventListener('click', (event) => {
    const btn = event.target.closest('.kanban-filter');
    if (!btn) return;
    kanbanFilter = btn.dataset.status || 'all';
    renderKanban();
  });
  // Escape menutup (listener document agar berlaku walau fokus di tombol ✕).
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal.dataset.open === 'true') closeKanbanModal();
  });
}
/* ======================= akhir VO2D-F3 modal ======================= */


function renderProfileRoster() {
  if (!ui.profileRoster) return;
  const profiles = Array.isArray(office.profiles) ? office.profiles : [];
  const signature = profiles.map((p) => `${p?.id}|${p?.display_name}|${p?.status}`).join(',');
  if (signature === rosterSignature) return;   // tidak ada perubahan -> tidak render ulang
  rosterSignature = signature;
  if (!profiles.length) { ui.profileRoster.innerHTML = '<div class="profile-roster-empty">Tidak ada profil.</div>'; return; }
  ui.profileRoster.innerHTML = profiles.map((profile) => {
    const alias = String(profile?.display_name || profile?.id || profileName(profile)).replace(/^@+/, '');
    const status = ['available', 'working', 'unknown'].includes(profile?.status) ? profile.status : 'unknown';
    // data-id = profile-id (bukan display name): server hanya menerima id roster
    // sebagai target eksplisit — "Mave" akan dibalas unknown_target (VO2D-F1).
    const pid = String(profile?.id || alias);
    return `<button type="button" class="profile-roster-item" data-alias="${escapeHtml(alias)}" data-id="${escapeHtml(pid)}"><i class="profile-status ${status}" aria-hidden="true"></i><span>${escapeHtml(alias)}</span></button>`;
  }).join('');
}

function renderActivity() {
  const recent = Array.isArray(office.recent) ? office.recent : [];
  if (!recent.length) { ui.activityList.innerHTML = '<div class="empty">Belum ada aktivitas.</div>'; return; }
  ui.activityList.innerHTML = recent.slice(0, 18).map((entry) => {
    const when = shortTime(entry.timestamp || entry.created_at || entry.updated_at);
    const who = escapeHtml(entry.profile || entry.actor || entry.assignee || 'system');
    const text = escapeHtml(entry.message || entry.action || entry.title || 'activity');
    return `<div class="activity-row"><time>${when}</time><span><b>${who}</b> ${text}</span></div>`;
  }).join('');
}

function profileForAgent(profile, task, kind) {
  const p = profile || {};
  const name = profileName(p);
  const matching = office.tasks.filter((t) => (t.assignee || t.profile || t.owner) === name);
  const active = task || matching.find((t) => t.status === 'running');
  const profileInfo = (Array.isArray(office.profiles_detail) ? office.profiles_detail : []).find((x) => profileName(x) === name) || {};
  ui.profileDetail.innerHTML = `
    <h3>${escapeHtml(name)}</h3>
    <p class="role">${escapeHtml(p.role || p.title || profileInfo.role || 'Hermes profile')}</p>
    <dl>
      <dt>Status</dt><dd>${kind === 'working' ? 'Working (HIJAU)' : kind === 'unknown' ? 'Telemetry unknown (MERAH)' : 'Available (KUNING)'}</dd>
      <dt>Source</dt><dd>${escapeHtml(p.source ?? 'unknown')}</dd>
      <dt>Runtime</dt><dd>${escapeHtml(p.runtime || p.model || '—')}</dd>
      <dt>Last seen</dt><dd>${escapeHtml(p.last_seen || p.updated_at || '—')}</dd>
      <dt>Probe</dt><dd>${p.probe_error ? 'probe_error' : 'OK / tidak diketahui'}</dd>
    </dl>
    <h4>Kartu</h4>
    ${matching.length ? matching.slice(0, 5).map((t) => `<div class="card-line"><b>${escapeHtml(t.status)}</b>${escapeHtml(t.title || t.id || 'Untitled task')}</div>`).join('') : '<div class="card-line">Belum ada kartu Kanban.</div>'}
    ${active ? `<div class="card-line"><b>RUNNING</b>${escapeHtml(active.title || active.id || '')}</div>` : ''}
  `;
  if (!ui.dialog.open) ui.dialog.showModal();
}

/** R6 (risiko label dobel): semua 4 room PNG sudah MENGANDUNG teks label
 *  yang di-bake di dalam seni ("CAFETERIA"/"MAIN OFFICE"/"MEETING ROOM"/
 *  "LOUNGE", putih ber-outline — terverifikasi via inspeksi piksel).
 *  Overlay DOM label DIMATIKAN agar tidak menumpuk dua kali di posisi yang
 *  berbeda. Fungsi dipertahankan (kontrak DOM #canvasOverlay tetap ada). */
function setOverlayLabels() {
  const overlay = $('canvasOverlay');
  if (!overlay) return;
  overlay.innerHTML = '';
  void GRID; void ZONES; // impor dipertahankan untuk kompatibilitas konsumen lain
}

function drawBase() {
  const base = document.createElement('canvas');
  base.width = WORLD_W;
  base.height = WORLD_H;
  const ctx = base.getContext('2d');
  renderBase(ctx);
  return base;
}

async function updateOffice() {
  const result = await fetchOffice();
  if (!result.ok) {
    setConnection(false, result.offline ? 'Offline' : `API ${result.httpStatus || 'error'}`);
    return;
  }
  const data = result.data;
  // Payload-level health (Dean B2): server bisa balas HTTP 200 dengan ok:false
  // (mis. roster rusak). Tanpa cek ini degradasi server senyap.
  if (data && data.ok === false) {
    setConnection(false, 'Degraded');
    console.warn('[office] payload degraded:', data.error);
    showToast(`Server: ${data.error || 'payload tidak sehat'}`);
    return;
  }
  data.tasks = normalizeTasks(data);
  office = { ...office, ...data };
  setConnection(true, 'Live');
  ui.updated.textContent = `updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  updateStats(office);
  renderTasks();
  renderActivity();
  renderProfileRoster();
  // VO2D-F3: modal Kanban ikut ter-refresh walau sedang terbuka (poll 5s).
  if (ui.kanbanModal?.dataset.open === 'true') renderKanban();
  if (animator) animator.setData(office.profiles, office.tasks);
  else {
    animator = new OfficeAnimator({
      canvas: ui.canvas, profiles: office.profiles, tasks: office.tasks,
      onAgentClick: profileForAgent,
      onWhiteboardClick: openKanbanModal, // VO2D-F3: klik papan -> modal Kanban
    });
    animator.setBase(drawBase());
  }
}

function renderChat(data) {
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const beforeHeight = ui.chatMessages.scrollHeight;
  const wasAtBottom = ui.chatMessages.scrollTop + ui.chatMessages.clientHeight >= beforeHeight - 30;
  const fragment = document.createDocumentFragment();
  const nextIds = new Set();
  for (const message of messages.slice(-60)) {
    const id = String(message.id || message.client_message_id || `${message.timestamp || ''}:${message.text || ''}`);
    nextIds.add(id);
    const node = document.createElement('div');
    node.className = `msg${message.mine ? ' mine' : ''}`;
    const who = escapeHtml(message.profile || message.sender || 'unknown');
    const when = shortTime(message.timestamp || message.created_at);
    const text = escapeHtml(message.text || message.message || '');
    const state = message.status && message.status !== 'sent' ? `<span class="msgstate">${escapeHtml(message.status)}</span>` : '';
    node.innerHTML = `<span class="msg-head">${who} · ${when}</span><span>${text}</span>${state}`;
    fragment.appendChild(node);
  }
  ui.chatMessages.replaceChildren(fragment);
  if (wasAtBottom || previousChatHeight === 0) ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
  for (const id of nextIds) {
    if (!lastMessageIds.has(id)) {
      const el = [...ui.chatMessages.children].find((node) => node.textContent.includes(id));
      if (el) el.classList.add('new-message');
    }
  }
  lastMessageIds = nextIds;
  previousChatHeight = ui.chatMessages.scrollHeight;
  ui.chatTarget.textContent = selectedTarget === 'all' ? '# all-hands' : `@${selectedTarget}`;
}

async function updateChat() {
  const result = await fetchChat();
  if (result.ok) {
    // CSRF: server mengirim token baru tiap GET /api/chat (payload.csrf + cookie).
    // Tanpa ini sendChat selalu 403 (Dean review 12 Okt — csrfToken tak pernah terisi).
    if (result.data?.csrf) csrfToken = result.data.csrf;
    renderChat(result.data);
  }
}

/** Auto-fit: world 1056x544 px lebih lebar dari viewport pada zoom 1 (R3). */
function fitScale() {
  const maxW = Math.max(320, ui.viewport.clientWidth - 20);
  const maxH = Math.max(250, ui.viewport.clientHeight - 20);
  return Math.min(maxW / WORLD_W, maxH / WORLD_H, 1);
}

function updateZoom() {
  const fit = fitScale();
  const scale = workspaceSnapshot ? fit : zoom;
  ui.wrap.style.width = `${WORLD_W * scale + 20}px`;
  ui.wrap.style.height = `${WORLD_H * scale + 20}px`;
  ui.wrap.style.transformOrigin = 'top left';
  ui.wrap.style.transform = `scale(${scale})`;
  ui.viewport.style.overflow = workspaceSnapshot ? 'hidden' : 'auto';
  if (workspaceSnapshot) {
    ui.viewport.scrollLeft = 0;
    ui.viewport.scrollTop = 0;
  }
  ui.zoomReset.textContent = `${Math.round(zoom * 100)}%`;
}

function toggleWorkspace() {
  if (!workspaceSnapshot) {
    workspaceSnapshot = { zoom, left: ui.viewport.scrollLeft, top: ui.viewport.scrollTop };
    ui.workspaceButton.setAttribute('aria-pressed', 'true');
    ui.workspaceButton.textContent = '⌖ Exit workspace';
  } else {
    zoom = workspaceSnapshot.zoom;
    const { left, top } = workspaceSnapshot;
    workspaceSnapshot = null;
    ui.workspaceButton.setAttribute('aria-pressed', 'false');
    ui.workspaceButton.textContent = '⌖ Workspace view';
    updateZoom();
    ui.viewport.scrollLeft = left;
    ui.viewport.scrollTop = top;
    return;
  }
  updateZoom();
}

function installZoom() {
  ui.zoomIn.addEventListener('click', () => { zoom = Math.min(2.5, zoom + 0.1); updateZoom(); });
  ui.zoomOut.addEventListener('click', () => { zoom = Math.max(0.45, zoom - 0.1); updateZoom(); });
  ui.zoomReset.addEventListener('click', () => { zoom = fitScale(); updateZoom(); });
  ui.workspaceButton.addEventListener('click', toggleWorkspace);
  window.addEventListener('resize', updateZoom, { passive: true });
  ui.viewport.addEventListener('scroll', () => {
    if (!workspaceSnapshot) workspaceSnapshot = null;
  }, { passive: true });
}

/** VO2D-F2: token mention -> profile-id valid roster.
 *  Server menolak display name ("Mave" -> unknown_target); hanya id yang valid.
 *  Fallback ke token mentah agar mention id eksplisit (@codi) tetap jalan. */
function resolveMentionTarget(token) {
  const raw = String(token || '').toLowerCase();
  if (!raw) return '';
  const profiles = Array.isArray(office.profiles) ? office.profiles : [];
  const hit = profiles.find((p) =>
    [p?.id, p?.display_name].some((v) => String(v || '').toLowerCase() === raw));
  return String(hit?.id || token);
}

/** VO2D-F2: state panel daftar profil.
 *  Desktop (≥721px): terbuka default — daftar terlihat permanen di kanan input.
 *  Mobile (≤720px): tertutup default — dibuka lewat tombol "👥 Profil". */
function setRosterOpen(open) {
  if (!ui.profileRoster || !ui.profileRosterToggle) return;
  rosterOpen = !!open;
  ui.profileRoster.hidden = !rosterOpen;
  ui.profileRosterToggle.setAttribute('aria-expanded', String(rosterOpen));
}

function installChat() {
  if (ui.profileRosterToggle && ui.profileRoster) {
    setRosterOpen(!window.matchMedia('(max-width: 720px)').matches);
    window.matchMedia('(max-width: 720px)').addEventListener('change', (event) => {
      setRosterOpen(!event.matches);
    });
    ui.profileRosterToggle.addEventListener('click', () => setRosterOpen(!rosterOpen));
    ui.profileRoster.addEventListener('click', (event) => {
      const item = event.target.closest('.profile-roster-item');
      if (!item) return;
      const mention = `@${item.dataset.alias || ''} `;
      const input = ui.chatInput;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      input.value = `${input.value.slice(0, start)}${mention}${input.value.slice(end)}`;
      input.focus();
      input.setSelectionRange(start + mention.length, start + mention.length);
      // Di mobile tutup panel setelah memilih (hemat ruang); desktop tetap terbuka.
      if (window.matchMedia('(max-width: 720px)').matches) setRosterOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && rosterOpen) {
        setRosterOpen(false);
        ui.profileRosterToggle.focus();
      }
    });
  }
  ui.chatMessages.addEventListener('click', (event) => {
    const node = event.target.closest('.msg');
    if (!node) return;
  });
  ui.chatForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = ui.chatInput.value.trim();
    if (!raw) return;
    let text = raw;
    let targetProfile = selectedTarget === 'all' ? 'all' : selectedTarget;
    const mention = raw.match(/^@([a-zA-Z0-9_.:-]+)\s+/);
    if (mention) { targetProfile = resolveMentionTarget(mention[1]) || 'all'; text = raw.slice(mention[0].length).trim(); }
    if (!text) { showToast('Pesan tidak boleh kosong.'); return; }
    const clientMessageId = (globalThis.crypto?.randomUUID?.() || `m-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    ui.chatInput.value = '';
    const optimistic = document.createElement('div');
    optimistic.className = 'msg mine';
    optimistic.innerHTML = `<span class="msg-head">you · ${shortTime(new Date())}</span><span>${escapeHtml(text)}</span><span class="msgstate">sending…</span>`;
    ui.chatMessages.appendChild(optimistic);
    ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
    const result = await sendChat({ text, targetProfile, clientMessageId, csrf: csrfToken });
    if (!result.ok) {
      optimistic.querySelector('.msgstate').textContent = `failed: ${result.error || 'network error'}`;
      showToast(`Chat gagal dikirim (${result.httpStatus || 'network'}).`);
      return;
    }
    optimistic.querySelector('.msgstate').textContent = '';
    await updateChat();
  });
}

async function bootstrap() {
  setOverlayLabels();
  await loadAssets();
  zoom = fitScale(); // default auto-fit (world 1056px > viewport)
  installZoom();
  installChat();
  installKanbanModal(); // VO2D-F3: modal Kanban (klik papan tulis)
  ui.taskFilter.addEventListener('change', renderTasks);
  ui.refreshButton.addEventListener('click', () => { updateOffice(); updateChat(); });
  await Promise.all([updateOffice(), updateChat()]);
  updateZoom();
  officeTimer = window.setInterval(updateOffice, POLL_MS);
  chatTimer = window.setInterval(updateChat, CHAT_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(officeTimer); clearInterval(chatTimer);
      if (animator) animator.dispose();
    } else {
      officeTimer = window.setInterval(updateOffice, POLL_MS);
      chatTimer = window.setInterval(updateChat, CHAT_POLL_MS);
      if (animator) { animator.disposed = false; animator.setData(office.profiles, office.tasks); }
      updateOffice(); updateChat();
    }
  });
}

bootstrap().catch((error) => {
  console.error('[virtual-office] bootstrap failed:', error);
  setConnection(false, 'UI error');
  showToast('Virtual Office gagal dimulai. Cek console/log.');
});

// Debug handle: dipakai QA (Harry/Dean) untuk memeriksa state animator tanpa membongkar bundle.
window.__office = {
  get animator() { return animator; },
  get state() {
    return {
      hidden: document.hidden,
      readyState: document.readyState,
      profiles: office.profiles.length,
      tasks: office.tasks.length,
      zoom,
      workspace: !!workspaceSnapshot,
      kanbanOpen: ui.kanbanModal?.dataset.open === 'true',
      agents: (animator?.agents || []).map((a) => ({ id: a.id, alias: a.profile?.display_name, visibleLabel: agentLabel(a), kind: a.kind, walking: a.walking, x: Math.round(a.x), y: Math.round(a.y), raf: animator?.raf, disposed: animator?.disposed, nextRoam: Math.round(a.nextRoamAt - performance.now()) })),
    };
  },
};
