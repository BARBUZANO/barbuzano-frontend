/* ==========================================================
   Área de clientes — MOCK de datos.
   Todo lo marcado con "TODO backend" es lo que habrá que
   sustituir por llamadas fetch() a los endpoints del Worker
   (files, folders, file_events) cuando el VPS esté listo.

   Contrato de datos previsto:
   - user:   { id, username, role: 'admin' | 'cliente' }
   - client: { id, username, display_name }
   - folder: { id, client_id, name }
   - file:   {
       id, folder_id, name, size, mime,
       direction: 'to_client' | 'to_admin',
       uploaded_by, uploaded_at, opened_at,
       status: 'nuevo' | 'abierto' | 'aceptado' | 'rechazado',
       history: [{ label, date, comment? }]
     }
   ========================================================== */

(() => {
  // ---------- Estado de la demo (rol activo, simulado) ----------
  let currentRole = 'cliente'; // 'cliente' | 'admin'
  let currentClientId = 'c1';
  let currentFolderId = 'f1';
  let currentTab = 'enviados'; // 'enviados' | 'recibidos'

  // ---------- Datos simulados ----------
  // TODO backend: sustituir por GET /api/clients (solo admin)
  const CLIENTS = [
    { id: 'c1', username: 'sebas', display_name: 'Sebas (tú)' },
    { id: 'c2', username: 'panaderia-lola', display_name: 'Panadería Lola' },
    { id: 'c3', username: 'garaje-nunez', display_name: 'Garaje Núñez' },
  ];

  // TODO backend: sustituir por GET /api/folders?client_id=
  const FOLDERS = {
    c1: [
      { id: 'f1', name: 'General' },
      { id: 'f2', name: 'IRPF 2025' },
    ],
    c2: [
      { id: 'f3', name: 'General' },
      { id: 'f4', name: 'Nóminas' },
    ],
    c3: [
      { id: 'f5', name: 'General' },
    ],
  };

  // TODO backend: sustituir por GET /api/files?folder_id=
  let FILES = [
    {
      id: 'file1', folder_id: 'f1', name: 'modelo-303-t3.pdf', size: '412 KB', mime: 'pdf',
      direction: 'to_admin', uploaded_by: 'sebas',
      uploaded_at: '2026-09-10 09:14', opened_at: '2026-09-10 11:02',
      status: 'abierto',
      history: [
        { label: 'Subido por Sebas', date: '10 sep · 09:14' },
        { label: 'Abierto por la asesoría', date: '10 sep · 11:02' },
      ],
    },
    {
      id: 'file2', folder_id: 'f1', name: 'factura-suministros-agosto.jpg', size: '1.1 MB', mime: 'jpg',
      direction: 'to_admin', uploaded_by: 'sebas',
      uploaded_at: '2026-09-14 18:40', opened_at: null,
      status: 'nuevo',
      history: [{ label: 'Subido por Sebas', date: '14 sep · 18:40' }],
    },
    {
      id: 'file3', folder_id: 'f1', name: 'liquidacion-trimestral-firmada.pdf', size: '288 KB', mime: 'pdf',
      direction: 'to_client', uploaded_by: 'asesoria',
      uploaded_at: '2026-09-15 10:05', opened_at: null,
      status: 'nuevo',
      history: [{ label: 'Subido por la asesoría', date: '15 sep · 10:05' }],
    },
    {
      id: 'file4', folder_id: 'f2', name: 'borrador-irpf.pdf', size: '190 KB', mime: 'pdf',
      direction: 'to_client', uploaded_by: 'asesoria',
      uploaded_at: '2026-09-12 12:00', opened_at: '2026-09-12 20:11',
      status: 'aceptado',
      history: [
        { label: 'Subido por la asesoría', date: '12 sep · 12:00' },
        { label: 'Abierto por el cliente', date: '12 sep · 20:11' },
        { label: 'Aceptado por el cliente', date: '12 sep · 20:13', comment: 'Todo correcto, gracias.' },
      ],
    },
  ];

  // ---------- Elementos ----------
  const $ = (sel) => document.querySelector(sel);
  const clientListEl = $('#client-list');
  const clientSwitcherSection = $('#client-switcher-section');
  const folderListEl = $('#folder-list');
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

  let activeFileId = null;
  let currentPreviewObjectUrl = null; // para poder liberarlo (revokeObjectURL) al cerrar

  // ---------- Render: selector de clientes (solo admin) ----------
  function renderClients() {
    clientSwitcherSection.hidden = currentRole !== 'admin';
    if (currentRole !== 'admin') return;

    clientListEl.innerHTML = CLIENTS.map((c) => `
      <li>
        <button type="button" data-client="${c.id}" class="${c.id === currentClientId ? 'is-active' : ''}">
          ${c.display_name}
        </button>
      </li>
    `).join('');
  }

  // ---------- Render: carpetas del cliente activo ----------
  function renderFolders() {
    const folders = FOLDERS[currentClientId] || [];
    if (!folders.find((f) => f.id === currentFolderId)) {
      currentFolderId = folders[0]?.id;
    }

    folderListEl.innerHTML = folders.map((f) => {
      const hasUnread = FILES.some((file) =>
        file.folder_id === f.id && file.status === 'nuevo' && isRelevantDirection(file)
      );
      return `
        <li>
          <button type="button" data-folder="${f.id}" class="${f.id === currentFolderId ? 'is-active' : ''}">
            <span>${f.name}</span>
            ${hasUnread ? '<span class="folder-unread"></span>' : ''}
          </button>
        </li>
      `;
    }).join('');

    const activeFolder = folders.find((f) => f.id === currentFolderId);
    folderTitleEl.textContent = activeFolder ? activeFolder.name : '—';
    contextEyebrowEl.textContent = currentRole === 'admin'
      ? CLIENTS.find((c) => c.id === currentClientId)?.display_name || 'Carpeta'
      : 'Carpeta';
  }

  // Un archivo es relevante para la pestaña activa según quién lo subió
  function isRelevantDirection(file) {
    if (currentTab === 'enviados') return file.direction === 'to_admin';
    return file.direction === 'to_client';
  }

  // ---------- Render: lista de archivos ----------
  function renderFiles() {
    const files = FILES.filter((f) => f.folder_id === currentFolderId && isRelevantDirection(f));

    dropzoneEl.style.display = currentTab === 'enviados' ? 'flex' : 'none';
    emptyStateEl.hidden = files.length > 0;
    fileListEl.innerHTML = files.map(fileRowTemplate).join('');
  }

  function fileRowTemplate(file) {
    const isUnread = file.status === 'nuevo' && shouldShowUnreadFor(file);
    return `
      <li class="file-row" data-file="${file.id}" tabindex="0">
        <span class="file-icon">${file.mime.toUpperCase()}</span>
        <div class="file-info">
          <p class="file-name">
            ${isUnread ? '<span class="unread-dot"></span>' : ''}
            ${file.name}
          </p>
          <p class="file-sub">${file.size} · ${file.uploaded_at}</p>
        </div>
        <span class="status-pill status-${file.status}">${statusLabel(file.status)}</span>
      </li>
    `;
  }

  // El punto de "nuevo" solo tiene sentido para quien lo recibe, no para quien lo sube
  function shouldShowUnreadFor(file) {
    if (currentRole === 'admin') return file.direction === 'to_admin';
    return file.direction === 'to_client';
  }

  function statusLabel(status) {
    return { nuevo: 'Nuevo', abierto: 'Abierto', aceptado: 'Aceptado', rechazado: 'Rechazado' }[status] || status;
  }

  function renderAll() {
    renderClients();
    renderFolders();
    renderFiles();
    userAvatarEl.textContent = currentRole === 'admin' ? 'A' : 'S';
    userNameEl.textContent = currentRole === 'admin' ? 'Barbuzano (admin)' : 'Sebas';
  }

  // ---------- Interacción: cambio de rol demo ----------
  $('#demo-switch').addEventListener('click', (e) => {
    const btn = e.target.closest('.demo-opt');
    if (!btn) return;
    currentRole = btn.dataset.role;
    currentClientId = 'c1';
    document.querySelectorAll('.demo-opt').forEach((b) => b.classList.toggle('is-active', b === btn));
    renderAll();
  });

  // ---------- Interacción: cambio de cliente (admin) ----------
  clientListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-client]');
    if (!btn) return;
    currentClientId = btn.dataset.client;
    currentFolderId = null;
    renderAll();
  });

  // ---------- Interacción: cambio de carpeta ----------
  folderListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-folder]');
    if (!btn) return;
    currentFolderId = btn.dataset.folder;
    renderFolders();
    renderFiles();
  });

  // ---------- Interacción: pestañas Enviados / Recibidos ----------
  tabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    currentTab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === btn));
    renderFolders();
    renderFiles();
  });

  // ---------- Interacción: nueva carpeta ----------
  $('#new-folder-btn').addEventListener('click', () => {
    const name = prompt('Nombre de la nueva carpeta:');
    if (!name) return;
    const id = 'f' + Math.random().toString(36).slice(2, 7);
    // TODO backend: POST /api/folders { client_id, name }
    FOLDERS[currentClientId] = FOLDERS[currentClientId] || [];
    FOLDERS[currentClientId].push({ id, name });
    currentFolderId = id;
    renderFolders();
    renderFiles();
  });

  // ---------- Interacción: subir archivo (dropzone) ----------
  dropzoneEl.addEventListener('click', () => fileInputEl.click());
  dropzoneEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputEl.click(); }
  });
  dropzoneEl.addEventListener('dragover', (e) => { e.preventDefault(); dropzoneEl.classList.add('is-dragover'); });
  dropzoneEl.addEventListener('dragleave', () => dropzoneEl.classList.remove('is-dragover'));
  dropzoneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzoneEl.classList.remove('is-dragover');
    if (e.dataTransfer.files.length) addMockFile(e.dataTransfer.files[0]);
  });
  fileInputEl.addEventListener('change', () => {
    if (fileInputEl.files.length) addMockFile(fileInputEl.files[0]);
    fileInputEl.value = '';
  });

  function addMockFile(file) {
    // TODO backend: POST /api/files (multipart) al bucket R2 + INSERT en tabla files
    const ext = (file.name.split('.').pop() || 'file').toLowerCase();
    const now = new Date().toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const uploader = currentRole === 'admin' ? 'asesoria' : 'sebas';
    FILES.unshift({
      id: 'file' + Math.random().toString(36).slice(2, 7),
      folder_id: currentFolderId,
      name: file.name,
      size: (file.size / 1024).toFixed(0) + ' KB',
      mime: ext,
      direction: currentRole === 'admin' ? 'to_client' : 'to_admin',
      uploaded_by: uploader,
      uploaded_at: now,
      opened_at: null,
      status: 'nuevo',
      // Solo en esta demo: como el archivo se ha elegido de verdad en el navegador,
      // podemos generar una URL local para previsualizarlo. Cuando el archivo venga
      // de R2, aquí irá la URL real de descarga/preview servida por el Worker.
      previewUrl: (ext === 'pdf' || ext === 'jpg' || ext === 'jpeg' || ext === 'png')
        ? URL.createObjectURL(file)
        : null,
      history: [{ label: `Subido por ${uploader === 'sebas' ? 'Sebas' : 'la asesoría'}`, date: now }],
    });
    renderFolders();
    renderFiles();
  }

  // ---------- Interacción: abrir modal de detalle ----------
  fileListEl.addEventListener('click', (e) => {
    const row = e.target.closest('.file-row');
    if (row) openFileModal(row.dataset.file);
  });

  function openFileModal(fileId) {
    const file = FILES.find((f) => f.id === fileId);
    if (!file) return;
    activeFileId = fileId;

    // Marcar como abierto si quien lo ve es el destinatario y aún está "nuevo"
    if (file.status === 'nuevo' && shouldShowUnreadFor(file)) {
      // TODO backend: PATCH /api/files/:id { status: 'abierto', opened_at: now }
      file.status = 'abierto';
      file.opened_at = new Date().toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      file.history.push({ label: 'Abierto', date: file.opened_at });
    }

    renderPreview(file);

    modalIcon.textContent = file.mime.toUpperCase();
    modalTitle.textContent = file.name;
    modalStatus.textContent = statusLabel(file.status);
    modalStatus.className = 'status-pill status-' + file.status;
    metaUploadedBy.textContent = file.uploaded_by === 'sebas' ? 'Sebas' : 'La asesoría';
    metaUploadedAt.textContent = file.uploaded_at;
    metaOpenedAt.textContent = file.opened_at || '— sin abrir aún —';
    historyListEl.innerHTML = file.history.map((h) => `
      <li><strong>${h.label}</strong><br>${h.date}${h.comment ? ` — “${h.comment}”` : ''}</li>
    `).join('');

    // Aceptar/rechazar solo tiene sentido para quien recibe el archivo
    commentBlock.style.display = shouldShowUnreadFor(file) ? 'block' : 'none';
    commentInput.value = '';

    modalOverlay.classList.add('is-open');
    modalOverlay.setAttribute('aria-hidden', 'false');
    renderFolders();
    renderFiles();
  }

  // TODO backend: cuando los archivos vengan de R2, esta función simplemente
  // apuntará <img>/<iframe> a la URL de descarga firmada que devuelva el Worker,
  // sin necesidad de distinguir "con preview real" vs "placeholder".
  function renderPreview(file) {
    if (currentPreviewObjectUrl) {
      URL.revokeObjectURL(currentPreviewObjectUrl);
      currentPreviewObjectUrl = null;
    }

    if (file.previewUrl) {
      currentPreviewObjectUrl = file.previewUrl.startsWith('blob:') ? file.previewUrl : null;
      if (file.mime === 'pdf') {
        previewEl.innerHTML = `<iframe src="${file.previewUrl}" title="Vista previa de ${file.name}"></iframe>`;
      } else {
        previewEl.innerHTML = `<img src="${file.previewUrl}" alt="Vista previa de ${file.name}">`;
      }
      return;
    }

    previewEl.innerHTML = `
      <div class="file-preview-placeholder">
        Vista previa no disponible todavía en esta demo.<br>
        Se mostrará aquí en cuanto el archivo venga del bucket real (R2).
      </div>
    `;
  }

  function closeFileModal() {
    modalOverlay.classList.remove('is-open');
    modalOverlay.setAttribute('aria-hidden', 'true');
    activeFileId = null;
    if (currentPreviewObjectUrl) {
      URL.revokeObjectURL(currentPreviewObjectUrl);
      currentPreviewObjectUrl = null;
    }
  }

  $('#file-modal-close').addEventListener('click', closeFileModal);
  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeFileModal(); });

  // ---------- Interacción: aceptar / rechazar ----------
  $('#accept-btn').addEventListener('click', () => resolveFile('aceptado'));
  $('#reject-btn').addEventListener('click', () => resolveFile('rechazado'));

  function resolveFile(status) {
    const file = FILES.find((f) => f.id === activeFileId);
    if (!file) return;
    // TODO backend: PATCH /api/files/:id { status, comment } → INSERT en file_events
    file.status = status;
    const now = new Date().toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    file.history.push({
      label: status === 'aceptado' ? 'Aceptado' : 'Rechazado',
      date: now,
      comment: commentInput.value.trim() || undefined,
    });
    closeFileModal();
    renderFolders();
    renderFiles();
  }

  // ---------- Interacción: logout ----------
  $('#logout-btn').addEventListener('click', () => {
    // TODO backend: POST /api/logout (ya implementado en el Worker) y redirigir a "/"
    window.location.href = '../index.html';
  });

  // ---------- Arranque ----------
  renderAll();
})();
