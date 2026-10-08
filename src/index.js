import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';

const SESSION_MAX_AGE_SECONDS = 86400; // 24h

async function getDbConnection(env) {
  return await mysql.createConnection({
    host: env.HYPERDRIVE.host,
    user: env.HYPERDRIVE.user,
    password: env.HYPERDRIVE.password,
    database: env.HYPERDRIVE.database,
    port: env.HYPERDRIVE.port,
    disableEval: true,
  });
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// ---------- Sesión (cookie firmada con HMAC, con caducidad) ----------

async function signSession(payload, secret) {
  const data = JSON.stringify(payload);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const sigHex = [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${btoa(data)}.${sigHex}`;
}

async function verifySession(cookieValue, secret) {
  if (!cookieValue) return null;
  const [encodedPayload, sigHex] = cookieValue.split('.');
  if (!encodedPayload || !sigHex) return null;

  const data = atob(encodedPayload);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const expectedSig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const expectedHex = [...new Uint8Array(expectedSig)].map(b => b.toString(16).padStart(2, '0')).join('');

  if (expectedHex !== sigHex) return null;

  const payload = JSON.parse(data);

  // La cookie del navegador caduca sola, pero si alguien reutiliza una
  // cookie copiada, esto la invalida igualmente en el servidor.
  if (!payload.exp || Date.now() > payload.exp) return null;

  return payload;
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}

async function requireSession(request, env) {
  const cookieValue = getCookie(request, 'session');
  return await verifySession(cookieValue, env.SESSION_SECRET);
}

// ---------- Utilidades de carpetas ----------

async function folderBelongsToClient(db, folderId, clientId) {
  if (!folderId) return true;
  const [rows] = await db.query(
    "SELECT id FROM folders WHERE id = ? AND client_id = ? AND status = 'activa'",
    [folderId, clientId]
  );
  return rows.length > 0;
}

// ¿Es esta sesión la destinataria del archivo?
// - Archivos 'cliente_a_asesoria' los recibe el admin.
// - Archivos 'asesoria_a_cliente' los recibe el cliente.
function isRecipient(file, session) {
  return (session.role === 'admin') === (file.direction === 'cliente_a_asesoria');
}

const DELETE_STATES = ['eliminacion_solicitada', 'eliminado'];

// ---------- Endpoints de archivos ----------

async function handleUpload(request, env, session) {
  const db = await getDbConnection(env);
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const folderId = formData.get('folder_id') || null;
    if (!file) return json({ error: 'Falta el archivo' }, 400);

    const direction = session.role === 'admin' ? 'asesoria_a_cliente' : 'cliente_a_asesoria';
    const clientId = session.role === 'admin' ? formData.get('client_id') : session.userId;
    if (!clientId) return json({ error: 'Falta client_id' }, 400);

    if (folderId && !(await folderBelongsToClient(db, folderId, clientId))) {
      return json({ error: 'La carpeta indicada no existe o está archivada' }, 403);
    }

    const uuid = crypto.randomUUID();
    const key = `clientes/${clientId}/${uuid}-${file.name}`;

    await env.BARBUZANO_FILES.put(key, file.stream(), {
      httpMetadata: { contentType: file.type },
    });

    const [result] = await db.query(
      `INSERT INTO files (client_id, folder_id, direction, uploaded_by, r2_key, original_filename, mime_type, size_bytes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'nuevo')`,
      [clientId, folderId, direction, session.userId, key, file.name, file.type, file.size]
    );
    await db.query(
      `INSERT INTO file_events (file_id, user_id, event_type) VALUES (?, ?, 'subida')`,
      [result.insertId, session.userId]
    );

    return json({ ok: true, fileId: result.insertId });
  } finally {
    await db.end();
  }
}

async function handleList(url, env, session) {
  const direction = url.searchParams.get('direction'); // opcional: sin él, devuelve ambas
  const folderId = url.searchParams.get('folder_id');
  const clientIdParam = url.searchParams.get('client_id');
  // Solo el admin puede ver los archivos eliminados (se conservan como histórico).
  const deleted = url.searchParams.get('deleted') === '1' && session.role === 'admin';

  const clientId = session.role === 'admin' && clientIdParam ? clientIdParam : session.userId;

  const where = ['files.client_id = ?'];
  const params = [clientId];
  if (deleted) {
    where.push("files.status = 'eliminado'");
  } else {
    where.push("files.status <> 'eliminado'");
    if (direction) { where.push('files.direction = ?'); params.push(direction); }
    if (folderId) { where.push('files.folder_id = ?'); params.push(folderId); }
    else { where.push('files.folder_id IS NULL'); }
  }

  const db = await getDbConnection(env);
  try {
    const [rows] = await db.query(
      `SELECT files.*, ru.role AS delete_requested_by_role
       FROM files LEFT JOIN users ru ON ru.id = files.delete_requested_by
       WHERE ${where.join(' AND ')} ORDER BY files.created_at DESC`,
      params
    );
    return json(rows);
  } finally {
    await db.end();
  }
}

async function handleDownload(fileId, env, session) {
  const db = await getDbConnection(env);
  try {
    const [rows] = await db.query(`SELECT * FROM files WHERE id = ?`, [fileId]);
    const file = rows[0];

    if (!file) return json({ error: 'No encontrado' }, 404);
    if (session.role !== 'admin' && file.client_id !== session.userId) {
      return json({ error: 'No autorizado' }, 403);
    }
    if (file.status === 'eliminado' && session.role !== 'admin') {
      return json({ error: 'No encontrado' }, 404);
    }

    const object = await env.BARBUZANO_FILES.get(file.r2_key);
    if (!object) return json({ error: 'Archivo no encontrado en R2' }, 404);

    // Solo el destinatario "abre" el archivo; si lo descarga quien lo subió, no cuenta.
    if (file.status === 'nuevo' && isRecipient(file, session)) {
      await db.query(`UPDATE files SET status = 'abierto' WHERE id = ?`, [fileId]);
      await db.query(
        `INSERT INTO file_events (file_id, user_id, event_type) VALUES (?, ?, 'apertura')`,
        [fileId, session.userId]
      );
    }

    return new Response(object.body, {
      headers: {
        ...corsHeaders,
        'Content-Type': file.mime_type || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${file.original_filename}"`,
      },
    });
  } finally {
    await db.end();
  }
}

async function handleStatusUpdate(fileId, request, env, session) {
  const { status, comment } = await request.json();
  const validStatuses = ['aceptado', 'aceptado_con_observaciones', 'rechazado'];
  if (!validStatuses.includes(status)) return json({ error: 'Estado inválido' }, 400);

  const db = await getDbConnection(env);
  try {
    const [rows] = await db.query(`SELECT * FROM files WHERE id = ?`, [fileId]);
    const file = rows[0];
    if (!file) return json({ error: 'No encontrado' }, 404);
    if (session.role !== 'admin' && file.client_id !== session.userId) {
      return json({ error: 'No autorizado' }, 403);
    }
    if (DELETE_STATES.includes(file.status)) {
      return json({ error: 'El archivo está pendiente de eliminación o eliminado' }, 409);
    }
    const lockedStatus = await archivedFolderError(db, file);
    if (lockedStatus) return lockedStatus;
    // Solo quien recibe el archivo puede aceptarlo o rechazarlo.
    if (!isRecipient(file, session)) {
      return json({ error: 'Solo el destinatario puede resolver este archivo' }, 403);
    }

    await db.query(`UPDATE files SET status = ? WHERE id = ?`, [status, fileId]);
    await db.query(
      `INSERT INTO file_events (file_id, user_id, event_type, comment) VALUES (?, ?, ?, ?)`,
      [fileId, session.userId, status, comment || null]
    );

    return json({ ok: true });
  } finally {
    await db.end();
  }
}

async function handleFileEvents(fileId, env, session) {
  const db = await getDbConnection(env);
  try {
    const [files] = await db.query('SELECT client_id FROM files WHERE id = ?', [fileId]);
    const file = files[0];
    if (!file) return json({ error: 'No encontrado' }, 404);
    if (session.role !== 'admin' && file.client_id !== session.userId) {
      return json({ error: 'No autorizado' }, 403);
    }

    const [rows] = await db.query(
      `SELECT e.event_type, e.comment, e.created_at, u.username, u.role
       FROM file_events e JOIN users u ON u.id = e.user_id
       WHERE e.file_id = ? ORDER BY e.created_at, e.id`,
      [fileId]
    );
    return json(rows);
  } finally {
    await db.end();
  }
}

// Carga el archivo y comprueba que la sesión tiene acceso (admin, o el cliente dueño).
async function loadAccessibleFile(db, fileId, session) {
  const [rows] = await db.query('SELECT * FROM files WHERE id = ?', [fileId]);
  const file = rows[0];
  if (!file) return { error: json({ error: 'No encontrado' }, 404) };
  if (session.role !== 'admin' && file.client_id !== session.userId) {
    return { error: json({ error: 'No autorizado' }, 403) };
  }
  return { file };
}

// Comentario suelto: lo pueden dejar el cliente y la asesoría sobre cualquier archivo suyo.
async function handleComment(fileId, request, env, session) {
  const { comment } = await request.json();
  const text = (comment || '').trim();
  if (!text) return json({ error: 'El comentario está vacío' }, 400);
  if (text.length > 1000) return json({ error: 'El comentario supera los 1000 caracteres' }, 400);

  const db = await getDbConnection(env);
  try {
    const { file, error } = await loadAccessibleFile(db, fileId, session);
    if (error) return error;
    if (file.status === 'eliminado') return json({ error: 'El archivo está eliminado' }, 409);
    const lockedComment = await archivedFolderError(db, file);
    if (lockedComment) return lockedComment;

    await db.query(
      `INSERT INTO file_events (file_id, user_id, event_type, comment) VALUES (?, ?, 'comentario', ?)`,
      [fileId, session.userId, text]
    );
    return json({ ok: true });
  } finally {
    await db.end();
  }
}

// Cualquiera de las dos partes puede pedir la eliminación; la otra debe confirmarla.
async function handleDeleteRequest(fileId, request, env, session) {
  const body = await request.json().catch(() => ({}));
  const comment = (body.comment || '').trim() || null;

  const db = await getDbConnection(env);
  try {
    const { file, error } = await loadAccessibleFile(db, fileId, session);
    if (error) return error;
    if (DELETE_STATES.includes(file.status)) {
      return json({ error: 'La eliminación de este archivo ya está solicitada o hecha' }, 409);
    }
    const lockedDelete = await archivedFolderError(db, file);
    if (lockedDelete) return lockedDelete;

    const [result] = await db.query(
      `UPDATE files SET status_before_delete = ?, status = 'eliminacion_solicitada', delete_requested_by = ?
       WHERE id = ? AND status = ?`,
      [file.status, session.userId, fileId, file.status]
    );
    if (result.affectedRows === 0) return json({ error: 'El archivo ha cambiado, recarga' }, 409);

    await db.query(
      `INSERT INTO file_events (file_id, user_id, event_type, comment) VALUES (?, ?, 'eliminacion_solicitada', ?)`,
      [fileId, session.userId, comment]
    );
    return json({ ok: true });
  } finally {
    await db.end();
  }
}

// accept / reject: solo la parte contraria a quien la pidió. cancel: solo quien la pidió.
async function handleDeleteResponse(fileId, request, env, session) {
  const { action, comment } = await request.json();
  if (!['accept', 'reject', 'cancel'].includes(action)) return json({ error: 'Acción inválida' }, 400);
  const note = (comment || '').trim() || null;

  const db = await getDbConnection(env);
  try {
    const { file, error } = await loadAccessibleFile(db, fileId, session);
    if (error) return error;
    if (file.status !== 'eliminacion_solicitada') {
      return json({ error: 'Este archivo no tiene una eliminación pendiente' }, 409);
    }

    const [users] = await db.query('SELECT role FROM users WHERE id = ?', [file.delete_requested_by]);
    const requesterIsAdmin = users[0]?.role === 'admin';
    const sameSide = requesterIsAdmin === (session.role === 'admin');

    if (action === 'cancel' && !sameSide) {
      return json({ error: 'Solo quien pidió la eliminación puede cancelarla' }, 403);
    }
    if (action !== 'cancel' && sameSide) {
      return json({ error: 'La eliminación debe confirmarla la otra parte' }, 403);
    }

    let result, eventType;
    if (action === 'accept') {
      [result] = await db.query(
        `UPDATE files SET status = 'eliminado' WHERE id = ? AND status = 'eliminacion_solicitada'`,
        [fileId]
      );
      eventType = 'eliminado';
    } else {
      [result] = await db.query(
        `UPDATE files SET status = COALESCE(status_before_delete, 'abierto'),
                status_before_delete = NULL, delete_requested_by = NULL
         WHERE id = ? AND status = 'eliminacion_solicitada'`,
        [fileId]
      );
      eventType = action === 'reject' ? 'eliminacion_rechazada' : 'eliminacion_cancelada';
    }
    if (result.affectedRows === 0) return json({ error: 'El archivo ha cambiado, recarga' }, 409);

    await db.query(
      `INSERT INTO file_events (file_id, user_id, event_type, comment) VALUES (?, ?, ?, ?)`,
      [fileId, session.userId, eventType, note]
    );
    return json({ ok: true });
  } finally {
    await db.end();
  }
}

// ---------- Endpoints de carpetas ----------

async function handleFolderCreate(request, env, session) {
  const { name, client_id, parent_id } = await request.json();
  if (!name) return json({ error: 'Falta el nombre' }, 400);

  const clientId = session.role === 'admin' && client_id ? client_id : session.userId;
  const direction = session.role === 'admin' ? 'asesoria_a_cliente' : 'cliente_a_asesoria';

  const db = await getDbConnection(env);
  try {
    if (parent_id && !(await folderBelongsToClient(db, parent_id, clientId))) {
      return json({ error: 'La carpeta padre no existe o está archivada' }, 403);
    }

    const [result] = await db.query(
      `INSERT INTO folders (client_id, name, parent_id, direction) VALUES (?, ?, ?, ?)`,
      [clientId, name, parent_id || null, direction]
    );

    return json({ ok: true, folderId: result.insertId });
  } finally {
    await db.end();
  }
}

async function handleFolderList(url, env, session) {
  const clientIdParam = url.searchParams.get('client_id');

  const db = await getDbConnection(env);
  try {
    // Admin sin client_id: carpetas de todos los clientes.
    if (session.role === 'admin' && !clientIdParam) {
      const [rows] = await db.query(
        `SELECT folders.*, users.username AS client_username, ru.role AS archive_requested_by_role
         FROM folders JOIN users ON users.id = folders.client_id
         LEFT JOIN users ru ON ru.id = folders.archive_requested_by
         WHERE folders.status <> 'eliminada'
         ORDER BY users.username, folders.name`
      );
      return json(rows);
    }

    // Cliente: solo las suyas. Admin con client_id: las de ese cliente.
    const clientId = session.role === 'admin' ? clientIdParam : session.userId;
    const [rows] = await db.query(
      `SELECT folders.*, ru.role AS archive_requested_by_role
       FROM folders LEFT JOIN users ru ON ru.id = folders.archive_requested_by
       WHERE folders.client_id = ? AND folders.status <> 'eliminada'
       ORDER BY folders.name`,
      [clientId]
    );
    return json(rows);
  } finally {
    await db.end();
  }
}

// ---------- Archivado de carpetas (doble verificación) ----------
// Archivar NO elimina nada: la carpeta y todos sus archivos se conservan, en solo lectura.

// Carga la carpeta y comprueba que la sesión tiene acceso (admin, o el cliente dueño).
async function loadAccessibleFolder(db, folderId, session) {
  const [rows] = await db.query('SELECT * FROM folders WHERE id = ?', [folderId]);
  const folder = rows[0];
  if (!folder || folder.status === 'eliminada') return { error: json({ error: 'No encontrado' }, 404) };
  if (session.role !== 'admin' && folder.client_id !== session.userId) {
    return { error: json({ error: 'No autorizado' }, 403) };
  }
  return { folder };
}

// Los archivos de una carpeta archivada son de solo lectura hasta que se restaure.
async function archivedFolderError(db, file) {
  if (!file.folder_id) return null;
  const [rows] = await db.query('SELECT status FROM folders WHERE id = ?', [file.folder_id]);
  return ['archivada', 'restauracion_solicitada'].includes(rows[0]?.status)
    ? json({ error: 'La carpeta está archivada. Restáurala para modificar sus archivos.' }, 409)
    : null;
}

// Cualquiera de las dos partes puede pedir el archivado; la otra debe confirmarlo.
async function handleFolderArchiveRequest(folderId, env, session) {
  const db = await getDbConnection(env);
  try {
    const { folder, error } = await loadAccessibleFolder(db, folderId, session);
    if (error) return error;
    if (folder.status !== 'activa') {
      return json({ error: 'Esta carpeta ya está archivada o tiene el archivado solicitado' }, 409);
    }

    const [result] = await db.query(
      `UPDATE folders SET status = 'archivacion_solicitada', archive_requested_by = ?, archive_requested_at = NOW()
       WHERE id = ? AND status = 'activa'`,
      [session.userId, folderId]
    );
    if (result.affectedRows === 0) return json({ error: 'La carpeta ha cambiado, recarga' }, 409);
    return json({ ok: true });
  } finally {
    await db.end();
  }
}

// accept / reject: solo la parte contraria a quien lo pidió. cancel: solo quien lo pidió.
// Sirve para el archivado y para la restauración; cambia solo el estado de partida y los de destino.
async function resolveFolderRequest(folderId, request, env, session, flow) {
  const { action } = await request.json();
  if (!['accept', 'reject', 'cancel'].includes(action)) return json({ error: 'Acción inválida' }, 400);

  const db = await getDbConnection(env);
  try {
    const { folder, error } = await loadAccessibleFolder(db, folderId, session);
    if (error) return error;
    if (folder.status !== flow.pending) {
      return json({ error: flow.notPending }, 409);
    }

    const [users] = await db.query('SELECT role FROM users WHERE id = ?', [folder.archive_requested_by]);
    const requesterIsAdmin = users[0]?.role === 'admin';
    const sameSide = requesterIsAdmin === (session.role === 'admin');

    if (action === 'cancel' && !sameSide) {
      return json({ error: 'Solo quien hizo la solicitud puede cancelarla' }, 403);
    }
    if (action !== 'cancel' && sameSide) {
      return json({ error: 'La solicitud debe confirmarla la otra parte' }, 403);
    }

    // accept -> estado final; reject / cancel -> se vuelve al estado anterior a la solicitud
    const target = action === 'accept' ? flow.accepted : flow.reverted;
    const [result] = await db.query(
      `UPDATE folders
       SET status = ?, archive_requested_by = NULL, archive_requested_at = NULL,
           archived_at = CASE WHEN ? = 'archivada' AND archived_at IS NULL THEN NOW()
                              WHEN ? = 'activa' THEN NULL ELSE archived_at END
       WHERE id = ? AND status = ?`,
      [target, target, target, folderId, flow.pending]
    );
    if (result.affectedRows === 0) return json({ error: 'La carpeta ha cambiado, recarga' }, 409);
    return json({ ok: true });
  } finally {
    await db.end();
  }
}

const handleFolderArchiveResponse = (folderId, request, env, session) =>
  resolveFolderRequest(folderId, request, env, session, {
    pending: 'archivacion_solicitada',
    accepted: 'archivada',
    reverted: 'activa',
    notPending: 'Esta carpeta no tiene un archivado pendiente',
  });

const handleFolderRestoreResponse = (folderId, request, env, session) =>
  resolveFolderRequest(folderId, request, env, session, {
    pending: 'restauracion_solicitada',
    accepted: 'activa',
    reverted: 'archivada',
    notPending: 'Esta carpeta no tiene una restauración pendiente',
  });

// Restaurar también necesita doble verificación: una parte solicita, la otra confirma.
async function handleFolderRestoreRequest(folderId, env, session) {
  const db = await getDbConnection(env);
  try {
    const { folder, error } = await loadAccessibleFolder(db, folderId, session);
    if (error) return error;
    if (folder.status !== 'archivada') {
      return json({ error: 'Esta carpeta no está archivada o ya tiene una solicitud pendiente' }, 409);
    }
    const [result] = await db.query(
      `UPDATE folders SET status = 'restauracion_solicitada', archive_requested_by = ?, archive_requested_at = NOW()
       WHERE id = ? AND status = 'archivada'`,
      [session.userId, folderId]
    );
    if (result.affectedRows === 0) return json({ error: 'La carpeta ha cambiado, recarga' }, 409);
    return json({ ok: true });
  } finally {
    await db.end();
  }
}

// ---------- Endpoint de clientes (solo admin) ----------

async function handleClientList(env) {
  const db = await getDbConnection(env);
  try {
    const [rows] = await db.query(
      `SELECT id, username FROM users WHERE role = 'cliente' AND active = 1 ORDER BY username`
    );
    return json(rows);
  } finally {
    await db.end();
  }
}

// ---------- Tareas ----------
// El asesor crea las tareas y es el único que puede completarlas, archivarlas o reabrirlas.
// El cliente solo ve las abiertas (pendiente / enviada) y puede avisar de que ya ha enviado lo pedido.
// Igual que con carpetas y archivos, nada se borra: las tareas se archivan.

const TASK_STATES = ['pendiente', 'enviada', 'completada', 'archivada'];

// Transiciones permitidas por rol: { estado actual: [estados a los que puede pasar] }
const TASK_TRANSITIONS = {
  admin: {
    pendiente: ['completada', 'archivada'],
    enviada: ['pendiente', 'completada', 'archivada'], // 'pendiente' = devolver al cliente
    completada: ['pendiente', 'archivada'],            // 'pendiente' = reabrir
    archivada: ['pendiente'],                          // 'pendiente' = reabrir
  },
  cliente: {
    pendiente: ['enviada'],
    enviada: ['pendiente'], // deshacer por si se equivocó
  },
};

function isValidDateString(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(`${str}T00:00:00Z`);
  return !isNaN(d) && d.toISOString().slice(0, 10) === str;
}

async function handleTaskList(url, env, session) {
  const admin = session.role === 'admin';
  const clientId = admin ? url.searchParams.get('client_id') : session.userId;
  if (!clientId) return json({ error: 'Falta client_id' }, 400);

  const db = await getDbConnection(env);
  try {
    // El cliente solo ve las abiertas; el asesor ve también completadas y archivadas.
    const statusFilter = admin ? '' : "AND status IN ('pendiente', 'enviada')";
    const [rows] = await db.query(
      `SELECT id, client_id, title, description, status,
              DATE_FORMAT(due_date, '%Y-%m-%d') AS due_date,
              created_at, sent_at, completed_at, archived_at
       FROM tasks
       WHERE client_id = ? ${statusFilter}
       ORDER BY (tasks.due_date IS NULL), tasks.due_date, tasks.id DESC`,
      [clientId]
    );
    return json(rows);
  } finally {
    await db.end();
  }
}

async function handleTaskCreate(request, env, session) {
  if (session.role !== 'admin') return json({ error: 'No autorizado' }, 403);

  const body = await request.json().catch(() => ({}));
  const clientId = body.client_id;
  const title = String(body.title ?? '').trim();
  const description = String(body.description ?? '').trim() || null;
  const dueDate = body.due_date || null;

  if (!clientId) return json({ error: 'Falta client_id' }, 400);
  if (!title) return json({ error: 'La tarea necesita un título' }, 400);
  if (title.length > 200) return json({ error: 'El título supera los 200 caracteres' }, 400);
  if (description && description.length > 2000) {
    return json({ error: 'La descripción supera los 2000 caracteres' }, 400);
  }
  if (dueDate && !isValidDateString(dueDate)) return json({ error: 'Fecha límite inválida' }, 400);

  const db = await getDbConnection(env);
  try {
    const [clients] = await db.query(
      `SELECT id FROM users WHERE id = ? AND role = 'cliente' AND active = 1`,
      [clientId]
    );
    if (clients.length === 0) return json({ error: 'Cliente no encontrado' }, 404);

    const [result] = await db.query(
      `INSERT INTO tasks (client_id, title, description, due_date, created_by) VALUES (?, ?, ?, ?, ?)`,
      [clientId, title, description, dueDate, session.userId]
    );
    return json({ ok: true, taskId: result.insertId });
  } finally {
    await db.end();
  }
}

async function handleTaskStatus(taskId, request, env, session) {
  const { status } = await request.json().catch(() => ({}));
  if (!TASK_STATES.includes(status)) return json({ error: 'Estado inválido' }, 400);

  const admin = session.role === 'admin';
  const db = await getDbConnection(env);
  try {
    const [rows] = await db.query('SELECT * FROM tasks WHERE id = ?', [taskId]);
    const task = rows[0];
    if (!task) return json({ error: 'No encontrada' }, 404);
    if (!admin && task.client_id !== session.userId) {
      return json({ error: 'No autorizado' }, 403);
    }

    const allowed = TASK_TRANSITIONS[admin ? 'admin' : 'cliente'][task.status] || [];
    if (!allowed.includes(status)) {
      return json({ error: 'Cambio de estado no permitido' }, 403);
    }

    const sets = ['status = ?'];
    if (status === 'pendiente') sets.push('sent_at = NULL', 'completed_at = NULL', 'archived_at = NULL');
    if (status === 'enviada') sets.push('sent_at = NOW()');
    if (status === 'completada') sets.push('completed_at = NOW()');
    if (status === 'archivada') sets.push('archived_at = NOW()');

    const [result] = await db.query(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND status = ?`,
      [status, taskId, task.status]
    );
    if (result.affectedRows === 0) return json({ error: 'La tarea ha cambiado, recarga' }, 409);
    return json({ ok: true });
  } finally {
    await db.end();
  }
}

// ---------- Router ----------

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // --- Login (público) ---
      if (path === '/api/login' && request.method === 'POST') {
        const { username, password } = await request.json();
        if (!username || !password) return json({ error: 'Faltan credenciales' }, 400);

        const db = await getDbConnection(env);
        let user;
        try {
          const [rows] = await db.query(
            'SELECT id, username, password_hash, active, role FROM users WHERE username = ?',
            [username]
          );
          user = rows[0];
        } finally {
          await db.end();
        }

        if (!user || !user.active) return json({ error: 'Usuario o contraseña incorrectos' }, 401);

        const passwordMatches = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatches) return json({ error: 'Usuario o contraseña incorrectos' }, 401);

        const sessionToken = await signSession(
          {
            userId: user.id,
            username: user.username,
            role: user.role,
            exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
          },
          env.SESSION_SECRET
        );

        return json(
          { message: 'Autenticación exitosa', user: { id: user.id, username: user.username, role: user.role } },
          200,
          { 'Set-Cookie': `session=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}` }
        );
      }

      // --- Logout (público) ---
      if (path === '/api/logout' && request.method === 'POST') {
        return json(
          { ok: true },
          200,
          { 'Set-Cookie': `session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0` }
        );
      }

      // --- Todo lo demás requiere sesión ---
      const session = await requireSession(request, env);
      if (!session) return json({ error: 'No autenticado' }, 401);

      if (path === '/api/me' && request.method === 'GET') {
        return json({ id: session.userId, username: session.username, role: session.role });
      }

      if (path === '/api/files/upload' && request.method === 'POST') {
        return await handleUpload(request, env, session);
      }

      const eventsMatch = path.match(/^\/api\/files\/(\d+)\/events$/);
      if (eventsMatch && request.method === 'GET') {
        return await handleFileEvents(eventsMatch[1], env, session);
      }

      if (path === '/api/files' && request.method === 'GET') {
        return await handleList(url, env, session);
      }

      const downloadMatch = path.match(/^\/api\/files\/(\d+)\/download$/);
      if (downloadMatch && request.method === 'GET') {
        return await handleDownload(downloadMatch[1], env, session);
      }

      const statusMatch = path.match(/^\/api\/files\/(\d+)\/status$/);
      if (statusMatch && request.method === 'PATCH') {
        return await handleStatusUpdate(statusMatch[1], request, env, session);
      }

      const commentMatch = path.match(/^\/api\/files\/(\d+)\/comments$/);
      if (commentMatch && request.method === 'POST') {
        return await handleComment(commentMatch[1], request, env, session);
      }

      const deleteRequestMatch = path.match(/^\/api\/files\/(\d+)\/delete-request$/);
      if (deleteRequestMatch && request.method === 'POST') {
        return await handleDeleteRequest(deleteRequestMatch[1], request, env, session);
      }

      const deleteResponseMatch = path.match(/^\/api\/files\/(\d+)\/delete-response$/);
      if (deleteResponseMatch && request.method === 'POST') {
        return await handleDeleteResponse(deleteResponseMatch[1], request, env, session);
      }

      if (path === '/api/folders' && request.method === 'POST') {
        return await handleFolderCreate(request, env, session);
      }

      if (path === '/api/folders' && request.method === 'GET') {
        return await handleFolderList(url, env, session);
      }

      const folderArchiveRequestMatch = path.match(/^\/api\/folders\/(\d+)\/archive-request$/);
      if (folderArchiveRequestMatch && request.method === 'POST') {
        return await handleFolderArchiveRequest(folderArchiveRequestMatch[1], env, session);
      }

      const folderArchiveResponseMatch = path.match(/^\/api\/folders\/(\d+)\/archive-response$/);
      if (folderArchiveResponseMatch && request.method === 'POST') {
        return await handleFolderArchiveResponse(folderArchiveResponseMatch[1], request, env, session);
      }

      const folderRestoreRequestMatch = path.match(/^\/api\/folders\/(\d+)\/restore-request$/);
      if (folderRestoreRequestMatch && request.method === 'POST') {
        return await handleFolderRestoreRequest(folderRestoreRequestMatch[1], env, session);
      }

      const folderRestoreResponseMatch = path.match(/^\/api\/folders\/(\d+)\/restore-response$/);
      if (folderRestoreResponseMatch && request.method === 'POST') {
        return await handleFolderRestoreResponse(folderRestoreResponseMatch[1], request, env, session);
      }

      if (path === '/api/tasks' && request.method === 'GET') {
        return await handleTaskList(url, env, session);
      }

      if (path === '/api/tasks' && request.method === 'POST') {
        return await handleTaskCreate(request, env, session);
      }

      const taskStatusMatch = path.match(/^\/api\/tasks\/(\d+)\/status$/);
      if (taskStatusMatch && request.method === 'PATCH') {
        return await handleTaskStatus(taskStatusMatch[1], request, env, session);
      }

      if (path === '/api/clients' && request.method === 'GET') {
        if (session.role !== 'admin') return json({ error: 'No autorizado' }, 403);
        return await handleClientList(env);
      }

      return new Response('Ruta no encontrada', { status: 404, headers: corsHeaders });

    } catch (err) {
      return json({ error: 'Error interno del servidor', details: err.message }, 500);
    }
  },
};
