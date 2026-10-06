/* ==========================================================
   Área de clientes — conectada al Worker (/api/*)

   Endpoints usados:
     GET   /api/me                      (nuevo, opcional: ver notas)
     GET   /api/clients                 (solo admin)
     GET   /api/folders?direction=&client_id=
     POST  /api/folders                 { name, client_id }
     GET   /api/files?direction=&folder_id=&client_id=
     POST  /api/files/upload            (multipart: file, folder_id, client_id)
     GET   /api/files/:id/download
     GET   /api/files/:id/events        (nuevo)
     PATCH /api/files/:id/status        { status, comment }
     POST  /api/logout

   Direcciones del servidor:
     'cliente_a_asesoria' | 'asesoria_a_cliente'
   Las pestañas son relativas a quien mira:
     Enviados  = lo que subo yo
     Recibidos = lo que me suben a mí
========================================================== */

(() => {
  'use strict';

  const API = '/api';
  const MAX_SIZE = 15 * 1024 * 1024; // 15 MB
  const ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png'];

  // ---------- Estado ----------
  const state = {
    me: null,            // { role, username, id? }
    clients: [],         // solo admin: [{ id, username }]
    clientId: null,      // solo admin: cliente seleccionado
    tab: 'todos',        // 'todos' | 'enviados' | 'recibidos' (solo filtra archivos)
    folderId: null,      // null = "General" (raíz, sin carpeta)
    folders: [],
    files: [],
    activeFileId: null,
    previewUrl: null,    // blob: URL a liberar al cerrar el modal
    modalToken: 0,       // invalida respuestas tardías del modal
    loadToken: 0,        // invalida respuestas tardías de las listas
  };

  // ---------- Elementos ----------
  const $ = (sel) => document.querySelector(sel);

  const clientListEl = $('#client-list');
  const clientSwitcherSection = $('#client-switcher-section');
  const folderListEl = $('#folder-list');
  const newFolderBtn = $('#new-folder-btn');
  const folderTitleEl = $('#folder-title');
  const contextEyebrowEl = $('#context-eyebrow');
  const fileListEl = $('#file-list');
  const emptyStateEl = $('#empty-state');
  const tabsEl = $('#tabs');
  const dropzoneEl = $('#dropzone');
  const fileInputEl = $('#file-input');
  const userAvatarEl = $('#user-avatar');
  const userNameEl = $('#user-name');

  const modalOverlay = $('#file-modal-overlay');
  const modalIcon = $('#file-modal-icon');
  const modalTitle = $('#file-modal-title');
  const modalStatus = $('#file-modal-status');
  const metaUploadedBy = $('#meta-uploaded-by');
  const metaUploadedAt = $('#meta-uploaded-at');
  const metaOpenedAt = $('#meta-opened-at');
  const historyListEl = $('#file-history-list');
  const commentBlock = $('#file-comment-block');
  const commentInput = $('#file-comment-input');
  const previewEl = $('#file-preview');

  // ---------- Utilidades ----------

  // Los nombres de archivo y carpeta los escriben los usuarios: siempre se escapan.
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

  const isAdmin = () => state.me?.role === 'admin';

  const SENT_BY_ME = () => (isAdmin() ? 'asesoria_a_cliente' : 'cliente_a_asesoria');
  const RECEIVED_BY_ME = () => (isAdmin() ? 'cliente_a_asesoria' : 'asesoria_a_cliente');

  // 'todos' => null (sin filtro de dirección)
  function directionForTab(tab) {
    if (tab === 'enviados') return SENT_BY_ME();
    if (tab === 'recibidos') return RECEIVED_BY_ME();
    return null;
  }

  // ¿Soy el destinatario de este archivo? (depende del archivo, no de la pestaña)
  const isRecipient = (file) => file.direction === RECEIVED_BY_ME();

  const currentClient = () =>
    state.clients.find((c) => String(c.id) === String(state.clientId));

  function formatDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d)) return '—';
    return d.toLocaleString('es-ES', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  }

  function formatSize(bytes) {
    const n = Number(bytes);
    if (!n && n !== 0) return '';
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function fileExt(file) {
    const name = file.original_filename || '';
    const ext = name.includes('.') ? name.split('.').pop() : '';
    return (ext || 'file').toLowerCase();
  }

  function statusLabel(status) {
    return {
      nuevo: 'Nuevo',
      abierto: 'Abierto',
      aceptado: 'Aceptado',
      aceptado_con_observaciones: 'Aceptado con observaciones',
      rechazado: 'Rechazado',
    }[status] || status;
  }

  function uploaderLabel(file) {
    if (file.direction === 'asesoria_a_cliente') return 'La asesoría';
    if (isAdmin()) return currentClient()?.username || 'Cliente';
    return state.me.username || 'Tú';
  }

  function showError(message) {
    alert(message);
  }

  // ---------- Capa de red ----------

  async function api(path, options = {}) {
    const res = await fetch(API + path, { credentials: 'same-origin', ...options });
    if (res.status === 401) {
      // Sesión caducada o inexistente: de vuelta a la página de inicio.
      window.location.href = '/';
      throw new Error('Sesión caducada');
    }
    return res;
  }

  async function apiJson(path, options) {
    const res = await api(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }

  async function loadMe() {
    try {
      return await apiJson('/me');
    } catch (e) {
      // Si /api/me aún no existe en el Worker, deducimos el rol:
      // /api/clients responde 200 solo a administradores.
      const res = await api('/clients');
      return res.ok
        ? { role: 'admin', username: 'Administrador' }
        : { role: 'cliente', username: 'Cliente' };
    }
  }

  // ---------- Carga de datos ----------

  function clientQuery(q) {
    if (isAdmin()) q.set('client_id', state.clientId);
    return q;
  }

  async function fetchFolders() {
    if (isAdmin() && state.clientId == null) return [];
    const q = clientQuery(new URLSearchParams());
    return apiJson('/folders?' + q);
  }

  async function fetchFiles() {
    if (isAdmin() && state.clientId == null) return [];
    const q = clientQuery(new URLSearchParams());
    const dir = directionForTab(state.tab);
    if (dir) q.set('direction', dir);
    if (state.folderId != null) q.set('folder_id', state.folderId);
    return apiJson('/files?' + q);
  }

  // Recarga carpetas + archivos (cambio de cliente, pestaña o carpeta nueva)
  async function refresh() {
    const token = ++state.loadToken;
    try {
      const folders = await fetchFolders();
      if (token !== state.loadToken) return;
      state.folders = folders;
      if (state.folderId != null && !folders.some((f) => f.id === state.folderId)) {
        state.folderId = null;
      }
      const files = await fetchFiles();
      if (token !== state.loadToken) return;
      state.files = files;
    } catch (e) {
      if (token === state.loadToken) showError(e.message);
    }
    renderAll();
  }

  // Recarga solo los archivos (tras subir, abrir o resolver)
  async function reloadFiles() {
    const token = ++state.loadToken;
    try {
      const files = await fetchFiles();
      if (token !== state.loadToken) return;
      state.files = files;
    } catch (e) {
      if (token === state.loadToken) showError(e.message);
    }
    renderFiles();
  }

  // ---------- Render: usuario ----------
  function renderUser() {
    const name = state.me.username || '?';
    userAvatarEl.textContent = name.charAt(0).toUpperCase();
    userNameEl.textContent = isAdmin() ? `${name} (admin)` : name;
  }

  // ---------- Render: selector de clientes (solo admin) ----------
  function renderClients() {
    clientSwitcherSection.hidden = !isAdmin();
    if (!isAdmin()) return;
    clientListEl.innerHTML = state.clients.map((c) => `
      <li>
        <button type="button" data-client="${esc(c.id)}"
                class="${String(c.id) === String(state.clientId) ? 'is-active' : ''}">
          ${esc(c.username)}
        </button>
      </li>
    `).join('');
  }

  // ---------- Render: carpetas ----------
  function renderFolders() {
    const items = [{ id: null, name: 'General' }, ...state.folders];
    const activeKey = state.folderId == null ? 'root' : String(state.folderId);

    folderListEl.innerHTML = items.map((f) => {
      const key = f.id == null ? 'root' : String(f.id);
      return `
        <li>
          <button type="button" data-folder="${key}" class="${key === activeKey ? 'is-active' : ''}">
            <span>${esc(f.name)}</span>
          </button>
        </li>
      `;
    }).join('');

    const active = items.find((f) => (f.id == null ? 'root' : String(f.id)) === activeKey);
    folderTitleEl.textContent = active ? active.name : '—';

    contextEyebrowEl.textContent = isAdmin()
      ? (currentClient()?.username || 'Sin clientes')
      : 'Carpeta';

  }

  // ---------- Render: archivos ----------
  function fileRowTemplate(file) {
    const isUnread = file.status === 'nuevo' && isRecipient(file);
    return `
      <li class="file-row" data-file="${esc(file.id)}" tabindex="0">
        <span class="file-icon">${esc(fileExt(file).toUpperCase())}</span>
        <div class="file-info">
          <p class="file-name">
            ${isUnread ? '<span class="unread-dot"></span>' : ''}
            ${esc(file.original_filename)}
          </p>
          <p class="file-sub">${esc(isRecipient(file) ? 'Recibido' : 'Enviado')} · ${esc(formatSize(file.size_bytes))} · ${esc(formatDate(file.created_at))}</p>
        </div>
        <span class="status-pill status-${esc(file.status)}">${esc(statusLabel(file.status))}</span>
      </li>
    `;
  }

  function renderFiles() {
    dropzoneEl.style.display = !(isAdmin() && state.clientId == null) ? 'flex' : 'none';

    emptyStateEl.textContent = isAdmin() && state.clientId == null
      ? 'Todavía no hay clientes dados de alta.'
      : 'No hay archivos en esta carpeta todavía.';
    emptyStateEl.hidden = state.files.length > 0;

    fileListEl.innerHTML = state.files.map(fileRowTemplate).join('');
  }

  function renderTabs() {
    document.querySelectorAll('.tab').forEach((t) =>
      t.classList.toggle('is-active', t.dataset.tab === state.tab)
    );
  }

  function renderAll() {
    renderClients();
    renderFolders();
    renderTabs();
    renderFiles();
  }

  // ---------- Interacción: cliente (admin) ----------
  clientListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-client]');
    if (!btn) return;
    state.clientId = btn.dataset.client;
    state.folderId = null;
    refresh();
  });

  // ---------- Interacción: carpeta ----------
  folderListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-folder]');
    if (!btn) return;
    state.folderId = btn.dataset.folder === 'root' ? null : Number(btn.dataset.folder);
    renderFolders();
    reloadFiles();
  });

  // ---------- Interacción: pestañas ----------
  tabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn || btn.dataset.tab === state.tab) return;
    state.tab = btn.dataset.tab;
    renderTabs();
    reloadFiles();
  });

  // ---------- Interacción: nueva carpeta ----------
  newFolderBtn.addEventListener('click', async () => {
    if (isAdmin() && state.clientId == null) return;
    const name = (prompt('Nombre de la nueva carpeta:') || '').trim();
    if (!name) return;

    try {
      const body = { name };
      if (isAdmin()) body.client_id = state.clientId;
      const { folderId } = await apiJson('/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      state.folderId = folderId;
      await refresh();
    } catch (e) {
      showError(e.message);
    }
  });

  // ---------- Interacción: subir archivo ----------
  dropzoneEl.addEventListener('click', () => fileInputEl.click());
  dropzoneEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputEl.click(); }
  });
  dropzoneEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzoneEl.classList.add('is-dragover');
  });
  dropzoneEl.addEventListener('dragleave', () => dropzoneEl.classList.remove('is-dragover'));
  dropzoneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzoneEl.classList.remove('is-dragover');
    if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
  });
  fileInputEl.addEventListener('change', () => {
    if (fileInputEl.files.length) uploadFile(fileInputEl.files[0]);
    fileInputEl.value = '';
  });

  async function uploadFile(file) {
    // El atributo accept del input no se aplica al arrastrar y soltar: se valida aquí.
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      return showError('Solo se admiten archivos PDF, JPG o PNG.');
    }
    if (file.size > MAX_SIZE) {
      return showError('El archivo supera el máximo de 15 MB.');
    }
    if (isAdmin() && state.clientId == null) {
      return showError('Selecciona primero un cliente.');
    }

    const form = new FormData();
    form.append('file', file);
    if (state.folderId != null) form.append('folder_id', state.folderId);
    if (isAdmin()) form.append('client_id', state.clientId);

    dropzoneEl.style.opacity = '0.5';
    dropzoneEl.style.pointerEvents = 'none';
    try {
      // Sin cabecera Content-Type: el navegador añade el boundary del multipart.
      const res = await api('/files/upload', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      await reloadFiles();
    } catch (e) {
      showError(e.message);
    } finally {
      dropzoneEl.style.opacity = '';
      dropzoneEl.style.pointerEvents = '';
    }
  }

  // ---------- Modal de detalle ----------
  fileListEl.addEventListener('click', (e) => {
    const row = e.target.closest('.file-row');
    if (row) openFileModal(row.dataset.file);
  });
  fileListEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const row = e.target.closest('.file-row');
    if (row) openFileModal(row.dataset.file);
  });

  function setPreviewMessage(html) {
    previewEl.innerHTML = `<div class="file-preview-placeholder">${html}</div>`;
  }

  function releasePreview() {
    if (state.previewUrl) {
      URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = null;
    }
  }

  function fillModalBasics(file) {
    modalIcon.textContent = fileExt(file).toUpperCase();
    modalTitle.textContent = file.original_filename;
    modalStatus.textContent = statusLabel(file.status);
    modalStatus.className = 'status-pill status-' + file.status;
    metaUploadedBy.textContent = uploaderLabel(file);
    metaUploadedAt.textContent = formatDate(file.created_at);
    metaOpenedAt.textContent = '—';

    const recipient = isRecipient(file);
    commentBlock.style.display = recipient ? 'block' : 'none';
    commentInput.value = '';
    commentInput.placeholder = isAdmin()
      ? 'Escribe un comentario para el cliente…'
      : 'Escribe un comentario para la asesoría…';
  }

  function eventLabel(ev) {
    const who = ev.role === 'admin' ? 'la asesoría' : (ev.username || 'el cliente');
    const verbs = {
      subida: 'Subido por',
      apertura: 'Abierto por',
      aceptado: 'Aceptado por',
      aceptado_con_observaciones: 'Aceptado con observaciones por',
      rechazado: 'Rechazado por',
    };
    return `${verbs[ev.event_type] || ev.event_type} ${who}`;
  }

  function renderHistory(file, events) {
    // Si el endpoint de eventos no está disponible, mostramos al menos la subida.
    const list = events || [{
      event_type: 'subida',
      role: file.direction === 'asesoria_a_cliente' ? 'admin' : 'cliente',
      username: uploaderLabel(file),
      created_at: file.created_at,
    }];

    historyListEl.innerHTML = list.map((ev) => `
      <li>
        <strong>${esc(eventLabel(ev))}</strong><br>${esc(formatDate(ev.created_at))}${
          ev.comment ? ` — “${esc(ev.comment)}”` : ''
        }
      </li>
    `).join('');

    const opened = events && events.find((ev) => ev.event_type === 'apertura');
    metaOpenedAt.textContent = opened ? formatDate(opened.created_at) : '— sin abrir aún —';
  }

  async function openFileModal(fileId) {
    const file = state.files.find((f) => String(f.id) === String(fileId));
    if (!file) return;

    releasePreview();
    state.activeFileId = file.id;
    const token = ++state.modalToken;

    fillModalBasics(file);
    historyListEl.innerHTML = '';
    setPreviewMessage('Cargando…');
    modalOverlay.classList.add('is-open');
    modalOverlay.setAttribute('aria-hidden', 'false');

    // 1) Descarga: el Worker marca el archivo como "abierto" al destinatario.
    try {
      const res = await api(`/files/${file.id}/download`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Error ${res.status}`);
      }
      const blob = await res.blob();
      if (token !== state.modalToken) return;

      state.previewUrl = URL.createObjectURL(blob);
      previewEl.innerHTML = '';
      const mime = file.mime_type || blob.type || '';
      if (mime === 'application/pdf') {
        const frame = document.createElement('iframe');
        frame.src = state.previewUrl;
        frame.title = `Vista previa de ${file.original_filename}`;
        previewEl.appendChild(frame);
      } else if (mime.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = state.previewUrl;
        img.alt = `Vista previa de ${file.original_filename}`;
        previewEl.appendChild(img);
      } else {
        setPreviewMessage('Vista previa no disponible para este tipo de archivo.');
      }
    } catch (e) {
      if (token !== state.modalToken) return;
      setPreviewMessage('No se ha podido cargar el archivo.');
    }

    // 2) Historial (después de la descarga, para que incluya la apertura)
    let events = null;
    try {
      events = await apiJson(`/files/${file.id}/events`);
    } catch (e) { /* endpoint opcional: se usa el historial mínimo */ }
    if (token !== state.modalToken) return;
    renderHistory(file, events);

    // 3) Estado actualizado (nuevo → abierto) en la lista y en el modal
    await reloadFiles();
    if (token !== state.modalToken) return;
    const fresh = state.files.find((f) => f.id === file.id);
    if (fresh) {
      modalStatus.textContent = statusLabel(fresh.status);
      modalStatus.className = 'status-pill status-' + fresh.status;
    }
  }

  function closeFileModal() {
    state.modalToken++;
    state.activeFileId = null;
    modalOverlay.classList.remove('is-open');
    modalOverlay.setAttribute('aria-hidden', 'true');
    previewEl.innerHTML = '';
    releasePreview();
  }

  $('#file-modal-close').addEventListener('click', closeFileModal);
  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeFileModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalOverlay.classList.contains('is-open')) closeFileModal();
  });

  // ---------- Aceptar / rechazar ----------
  $('#accept-btn').addEventListener('click', () => resolveFile('aceptado'));
  $('#reject-btn').addEventListener('click', () => resolveFile('rechazado'));

  async function resolveFile(status) {
    if (state.activeFileId == null) return;
    const fileId = state.activeFileId;
    const comment = commentInput.value.trim();

    try {
      await apiJson(`/files/${fileId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, comment: comment || null }),
      });
      closeFileModal();
      await reloadFiles();
    } catch (e) {
      showError(e.message);
    }
  }

  // ---------- Cerrar sesión ----------
  $('#logout-btn').addEventListener('click', async () => {
    try { await api('/logout', { method: 'POST' }); } catch (e) { /* da igual */ }
    window.location.href = '/';
  });

  // ---------- Arranque ----------
  async function init() {
    // El selector de rol era solo para la maqueta.
    document.getElementById('demo-switch')?.remove();

    try {
      state.me = await loadMe();
      if (isAdmin()) {
        state.clients = await apiJson('/clients');
        state.clientId = state.clients.length ? state.clients[0].id : null;
      }
    } catch (e) {
      return showError(e.message);
    }

    renderUser();
    await refresh();
  }

  init();
})();
