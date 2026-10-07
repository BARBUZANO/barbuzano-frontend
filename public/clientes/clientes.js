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
    tab: 'todos',        // 'todos' | 'enviados' | 'recibidos' | 'eliminados' (admin)
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
  const folderActionEl = $('#folder-action');
  const folderActionMsgEl = $('#folder-action-msg');
  const folderActionActionsEl = $('#folder-action-actions');
  const folderArchiveEl = $('#folder-archive');
  const folderArchiveListEl = $('#folder-archive-list');
  const folderArchiveCountEl = $('#folder-archive-count');
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
  const commentSendBtn = $('#comment-send-btn');
  const resolveActionsEl = $('#resolve-actions');
  const deleteMsgEl = $('#file-delete-msg');
  const deleteActionsEl = $('#file-delete-actions');
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

  const activeFolder = () =>
    state.folderId == null ? null : (state.folders.find((f) => f.id === state.folderId) || null);

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
      eliminacion_solicitada: 'Eliminación solicitada',
      eliminado: 'Eliminado',
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
    if (state.tab === 'eliminados') {
      q.set('deleted', '1');
    } else {
      const dir = directionForTab(state.tab);
      if (dir) q.set('direction', dir);
      if (state.folderId != null) q.set('folder_id', state.folderId);
    }
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
    const activeKey = state.folderId == null ? 'root' : String(state.folderId);
    const current = state.folders.filter((f) => f.status !== 'archivada');
    const archived = state.folders.filter((f) => f.status === 'archivada');

    const folderItem = (f) => {
      const key = f.id == null ? 'root' : String(f.id);
      return `
        <li>
          <button type="button" data-folder="${key}" class="${key === activeKey ? 'is-active' : ''}">
            <span>${esc(f.name)}</span>
            ${f.status === 'archivacion_solicitada' ? '<span class="folder-pending" title="Archivado solicitado"></span>' : ''}
          </button>
        </li>
      `;
    };

    folderListEl.innerHTML = [{ id: null, name: 'General' }, ...current].map(folderItem).join('');
    folderArchiveListEl.innerHTML = archived.map(folderItem).join('');
    folderArchiveEl.hidden = archived.length === 0;
    folderArchiveCountEl.textContent = archived.length ? `(${archived.length})` : '';
    // Si la carpeta abierta está archivada, se despliega la sección para que se vea dónde está.
    if (activeFolder()?.status === 'archivada') folderArchiveEl.open = true;

    const active = state.folderId == null ? { name: 'General' } : activeFolder();
    folderTitleEl.textContent = state.tab === 'eliminados'
      ? 'Archivos eliminados'
      : (active ? active.name : '—');

    contextEyebrowEl.textContent = isAdmin()
      ? (currentClient()?.username || 'Sin clientes')
      : 'Carpeta';

    renderFolderAction();
  }

  // Barra de la carpeta activa: archivar / restaurar (la raíz "General" no se puede archivar).
  function renderFolderAction() {
    const folder = activeFolder();
    if (!folder || state.tab === 'eliminados') {
      folderActionEl.hidden = true;
      return;
    }

    const myRole = isAdmin() ? 'admin' : 'cliente';
    let msg = '';
    let buttons = '';

    if (folder.status === 'archivada') {
      msg = 'Carpeta archivada: conserva todos sus documentos, en modo solo lectura.';
      buttons = '<button type="button" class="pill-btn ghost-btn" data-folder-action="restore">Restaurar carpeta</button>';
    } else if (folder.status === 'archivacion_solicitada') {
      if (folder.archive_requested_by_role === myRole) {
        msg = 'Has solicitado archivar esta carpeta. Falta que la otra parte lo confirme.';
        buttons = '<button type="button" class="pill-btn outline-btn" data-folder-action="cancel">Cancelar solicitud</button>';
      } else {
        msg = 'La otra parte ha solicitado archivar esta carpeta. No se elimina ningún documento.';
        buttons = `
          <button type="button" class="pill-btn outline-btn" data-folder-action="reject">Mantener activa</button>
          <button type="button" class="pill-btn ghost-btn" data-folder-action="accept">Aceptar archivado</button>`;
      }
    } else {
      msg = 'Archivar conserva la carpeta y todos sus documentos; solo dejan de estar en la lista principal.';
      buttons = '<button type="button" class="pill-btn ghost-btn" data-folder-action="request">Archivar carpeta</button>';
    }

    folderActionMsgEl.textContent = msg;
    folderActionActionsEl.innerHTML = buttons;
    folderActionEl.hidden = false;
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
    const folderLocked = !!activeFolder() && activeFolder().status !== 'activa';
    dropzoneEl.style.display = state.tab !== 'eliminados' && !folderLocked && !(isAdmin() && state.clientId == null)
      ? 'flex' : 'none';

    emptyStateEl.textContent = isAdmin() && state.clientId == null
      ? 'Todavía no hay clientes dados de alta.'
      : 'No hay archivos en esta carpeta todavía.';
    emptyStateEl.hidden = state.files.length > 0;

    fileListEl.innerHTML = state.files.map(fileRowTemplate).join('');
  }

  function renderTabs() {
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('is-active', t.dataset.tab === state.tab);
      // "Eliminados" es solo para la asesoría.
      if (t.dataset.tab === 'eliminados') t.style.display = isAdmin() ? '' : 'none';
    });
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
  function onFolderClick(e) {
    const btn = e.target.closest('button[data-folder]');
    if (!btn) return;
    state.folderId = btn.dataset.folder === 'root' ? null : Number(btn.dataset.folder);
    renderFolders();
    reloadFiles();
  }
  folderListEl.addEventListener('click', onFolderClick);
  folderArchiveListEl.addEventListener('click', onFolderClick);

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

  // ---------- Interacción: archivar / restaurar carpeta ----------
  folderActionActionsEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-folder-action]');
    const folder = activeFolder();
    if (!btn || !folder) return;
    const action = btn.dataset.folderAction;

    const confirmations = {
      request: `¿Solicitar el archivado de la carpeta «${folder.name}»? La otra parte tendrá que confirmarlo. No se elimina ningún documento.`,
      accept: `¿Aceptar el archivado de la carpeta «${folder.name}»? Pasará a "Archivadas" con todos sus documentos.`,
      restore: `¿Restaurar la carpeta «${folder.name}»? Volverá a la lista principal y se podrá modificar de nuevo.`,
    };
    if (confirmations[action] && !confirm(confirmations[action])) return;

    let path, body = {};
    if (action === 'request') path = `/folders/${folder.id}/archive-request`;
    else if (action === 'restore') path = `/folders/${folder.id}/restore`;
    else { path = `/folders/${folder.id}/archive-response`; body = { action }; }

    try {
      await apiJson(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await refresh();
    } catch (err) {
      showError(err.message);
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

    const pending = file.status === 'eliminacion_solicitada';
    const deleted = file.status === 'eliminado';
    const readOnly = isInArchivedFolder(file);

    // Comentar pueden ambos; aceptar/rechazar solo el destinatario y si no hay eliminación en curso.
    // En una carpeta archivada todo es de solo lectura.
    commentBlock.style.display = deleted || readOnly ? 'none' : 'block';
    resolveActionsEl.style.display = isRecipient(file) && !pending && !deleted && !readOnly ? 'flex' : 'none';
    commentInput.value = '';
    commentInput.placeholder = isAdmin()
      ? 'Escribe un comentario para el cliente…'
      : 'Escribe un comentario para la asesoría…';

    renderDeleteBlock(file);
  }

  function isInArchivedFolder(file) {
    return file.folder_id != null
      && state.folders.find((f) => f.id === file.folder_id)?.status === 'archivada';
  }

  function renderDeleteBlock(file) {
    const myRole = isAdmin() ? 'admin' : 'cliente';
    let msg = '';
    let buttons = '';

    if (file.status === 'eliminado') {
      msg = 'Este archivo está eliminado. Se conserva como histórico.';
    } else if (file.status === 'eliminacion_solicitada') {
      if (file.delete_requested_by_role === myRole) {
        msg = 'Has solicitado eliminar este archivo. Falta que la otra parte lo confirme.';
        buttons = '<button type="button" class="pill-btn outline-btn" data-delete="cancel">Cancelar solicitud</button>';
      } else {
        msg = 'La otra parte ha solicitado eliminar este archivo.';
        buttons = `
          <button type="button" class="pill-btn outline-btn" data-delete="reject">Mantener archivo</button>
          <button type="button" class="pill-btn ghost-btn" data-delete="accept">Aceptar eliminación</button>`;
      }
    } else if (isInArchivedFolder(file)) {
      msg = 'Esta carpeta está archivada: sus archivos son de solo lectura. Restáurala para modificarlos.';
    } else {
      buttons = '<button type="button" class="pill-btn ghost-btn" data-delete="request">Solicitar eliminación</button>';
    }

    deleteMsgEl.textContent = msg;
    deleteActionsEl.innerHTML = buttons;
  }

  function eventLabel(ev) {
    const who = ev.role === 'admin' ? 'la asesoría' : (ev.username || 'el cliente');
    const verbs = {
      subida: 'Subido por',
      apertura: 'Abierto por',
      aceptado: 'Aceptado por',
      aceptado_con_observaciones: 'Aceptado con observaciones por',
      rechazado: 'Rechazado por',
      comentario: 'Comentario de',
      eliminacion_solicitada: 'Eliminación solicitada por',
      eliminacion_rechazada: 'Eliminación rechazada por',
      eliminacion_cancelada: 'Solicitud de eliminación cancelada por',
      eliminado: 'Eliminación confirmada por',
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

    // Los comentarios se pintan en su propio bloque, con el color del rol de quien los escribe.
    historyListEl.innerHTML = list.map((ev) => `
      <li class="role-${ev.role === 'admin' ? 'admin' : 'cliente'}${ev.comment ? ' has-comment' : ''}">
        <strong>${esc(eventLabel(ev))}</strong>
        <span class="history-date">${esc(formatDate(ev.created_at))}</span>
        ${ev.comment ? `<p class="history-comment">${esc(ev.comment)}</p>` : ''}
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

  // ---------- Comentarios y eliminación ----------

  // Recarga la lista y vuelve a pintar el modal con el estado actualizado.
  async function refreshModal() {
    const id = state.activeFileId;
    if (id == null) return;
    const token = state.modalToken;

    await reloadFiles();
    if (token !== state.modalToken) return;

    let events = null;
    try { events = await apiJson(`/files/${id}/events`); } catch (e) { /* opcional */ }
    if (token !== state.modalToken) return;

    const fresh = state.files.find((f) => String(f.id) === String(id));
    if (!fresh) { closeFileModal(); return; } // ya no aparece en esta vista (p. ej. eliminado)
    fillModalBasics(fresh);
    renderHistory(fresh, events);
  }

  commentSendBtn.addEventListener('click', async () => {
    if (state.activeFileId == null) return;
    const comment = commentInput.value.trim();
    if (!comment) return showError('Escribe un comentario antes de enviarlo.');
    try {
      await apiJson(`/files/${state.activeFileId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment }),
      });
      await refreshModal();
    } catch (e) {
      showError(e.message);
    }
  });

  deleteActionsEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-delete]');
    if (!btn || state.activeFileId == null) return;
    const action = btn.dataset.delete;

    const confirmations = {
      request: '¿Solicitar la eliminación de este archivo? La otra parte tendrá que confirmarla.',
      accept: '¿Aceptar la eliminación? El archivo dejará de aparecer en tu lista.',
    };
    if (confirmations[action] && !confirm(confirmations[action])) return;

    const [path, body] = action === 'request'
      ? [`/files/${state.activeFileId}/delete-request`, {}]
      : [`/files/${state.activeFileId}/delete-response`, { action }];

    try {
      await apiJson(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await refreshModal();
    } catch (err) {
      showError(err.message);
    }
  });

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
