import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';

const SESSION_MAX_AGE_SECONDS = 86400; // 24h

// Límites de entrada
const MAX_USERNAME_LENGTH = 100;
const MAX_PASSWORD_LENGTH = 200;
const MAX_COMMENT_LENGTH = 1000;
const MAX_FOLDER_NAME_LENGTH = 100;
const MAX_FILENAME_LENGTH = 200;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

// Tipos de archivo permitidos en las subidas. Amplía la lista si hace falta (xlsx, docx, csv...).
const ALLOWED_UPLOAD_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

// Hash bcrypt de una cadena aleatoria: se usa cuando el usuario no existe para que el
// login tarde lo mismo y no revele qué usuarios son válidos.
const DUMMY_HASH = '$2b$10$tVU2iKWfNZBd7BwUkkjtUONsKQS1/FfrEK2z6ktzW1t74.baCL8by';

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

// La web y la API son el mismo Worker (mismo origen), así que no se necesita CORS.
const baseHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...baseHeaders, ...extraHeaders },
  });
}

// ---------- Validación de entrada ----------
// Con mysql2, un objeto o array en un parámetro "?" se expande a SQL (p. ej. {"id":1} -> `id` = 1).
// Por eso todo valor que venga del cliente se fuerza a su tipo esperado antes de consultar.

// Id entero positivo o null.
function toId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !/^\d{1,15}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Id opcional: undefined = inválido, null = no informado, número = válido.
function toOptionalId(value) {
  if (value === undefined || value === null || value === '') return null;
  return toId(value) ?? undefined;
}

// Texto: '' si no viene, null si es inválido (no es string o supera el máximo).
function readText(value, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > max ? null : text;
}

async function readJson(request) {
  const body = await request.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

// Nombre de archivo seguro para guardar y para cabeceras.
function sanitizeFilename(name) {
  const clean = String(name ?? 'archivo')
    .replace(/[\x00-\x1f\x7f"\\/:*?<>|]/g, '_')
    .trim();
  const finalName = clean.length > MAX_FILENAME_LENGTH ? clean.slice(-MAX_FILENAME_LENGTH) : clean;
  return finalName || 'archivo';
}

// ---------- Sesión (cookie firmada con HMAC, con caducidad) ----------

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
}

async function hmacKey(secret, usages) {
  return await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages
  );
}

async function signSession(payload, secret) {
  const data = JSON.stringify(payload);
  const key = await hmacKey(secret, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${toBase64(data)}.${bytesToHex(new Uint8Array(signature))}`;
}

async function verifySession(cookieValue, secret) {
  if (!cookieValue) return null;
  try {
    const [encodedPayload, sigHex, extra] = cookieValue.split('.');
    if (!encodedPayload || !sigHex || extra !== undefined) return null;

    const sigBytes = hexToBytes(sigHex);
    if (!sigBytes) return null;

    const data = fromBase64(encodedPayload);
    const key = await hmacKey(secret, ['verify']);
    // crypto.subtle.verify compara en tiempo constante
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
    if (!valid) return null;

    const payload = JSON.parse(data);

    // La cookie del navegador caduca sola, pero si alguien reutiliza una
    // cookie copiada, esto la invalida igualmente en el servidor.
    if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;

    return payload;
  } catch {
    // Cookie malformada: se trata como no autenticado, no como error interno.
    return null;
  }
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie') || '';
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

async function requireSession(request, env) {
  const cookieValue = getCookie(request, 'session');
  return await verifySession(cookieValue, env.SESSION_SECRET);
}

// Comprueba en la base de datos que el usuario sigue existiendo y activo, y toma de ahí
// su rol actual (así un cambio de rol o una desactivación surten efecto de inmediato).
async function loadActiveSession(env, cookieSession) {
  const userId = toId(cookieSession.userId);
  if (!userId) return null;

  const db = await getDbConnection(env);
  try {
    const [rows] = await db.query(
      'SELECT id, username, role, active FROM users WHERE id = ?',
      [userId]
    );
    const user = rows[0];
    if (!user || !user.active) return null;
    return { userId: user.id, username: user.username, role: user.role };
  } finally {
    await db.end();
  }
}

// ---------- Utilidades de carpetas y clientes ----------

async function folderBelongsToClient(db, folderId, clientId) {
  if (!folderId) return true;
  const [rows] = await db.query(
    "SELECT id FROM folders WHERE id = ? AND client_id = ? AND status = 'activa'",
    [folderId, clientId]
  );
  return rows.length > 0;
}

async function clientExists(db, clientId) {
  const [rows] = await db.query(
    "SELECT id FROM users WHERE id = ? AND role = 'cliente' AND active = 1",
    [clientId]
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
  const formData = await request.formData();
  const file = formData.get('file');
  if (!file || typeof file === 'string') return json({ error: 'Falta el archivo' }, 400);

  if (file.size > MAX_UPLOAD_BYTES) {
    return json({ error: 'El archivo supera el tamaño máximo (25 MB)' }, 413);
  }
  if (!ALLOWED_UPLOAD_TYPES.includes(file.type)) {
    return json({ error: 'Tipo de archivo no permitido (solo PDF, JPG o PNG)' }, 415);
  }

  const folderId = toOptionalId(formData.get('folder_id'));
  if (folderId === undefined) return json({ error: 'folder_id inválido' }, 400);

  const isAdmin = session.role === 'admin';
  const direction = isAdmin ? 'asesoria_a_cliente' : 'cliente_a_asesoria';
  const clientId = toId(isAdmin ? formData.get('client_id') : session.userId);
  if (!clientId) return json({ error: 'Falta client_id' }, 400);

  const db = await getDbConnection(env);
  try {
    if (isAdmin && !(await clientExists(db, clientId))) {
      return json({ error: 'Cliente no encontrado' }, 404);
    }
    if (folderId && !(await folderBelongsToClient(db, folderId, clientId))) {
      return json({ error: 'La carpeta indicada no existe o está archivada' }, 403);
    }

    const safeName = sanitizeFilename(file.name);
    const uuid = crypto.randomUUID();
    const key = `clientes/${clientId}/${uuid}-${safeName}`;

    await env.BARBUZANO_FILES.put(key, file.stream(), {
      httpMetadata: { contentType: file.type },
    });

    const [result] = await db.query(
      `INSERT INTO files (client_id, folder_id, direction, uploaded_by, r2_key, original_filename, mime_type, size_bytes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'nuevo')`,
      [clientId, folderId, direction, session.userId, key, safeName, file.type, file.size]
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
  const directionParam = url.searchParams.get('direction'); // opcional: sin él, devuelve ambas
  if (directionParam && !['cliente_a_asesoria', 'asesoria_a_cliente'].includes(directionParam)) {
    return json({ error: 'direction inválido' }, 400);
  }
  const direction = directionParam || null;

  const folderId = toOptionalId(url.searchParams.get('folder_id'));
  if (folderId === undefined) return json({ error: 'folder_id inválido' }, 400);

  const clientIdParam = toOptionalId(url.searchParams.get('client_id'));
  if (clientIdParam === undefined) return json({ error: 'client_id inválido' }, 400);

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

    const safeName = sanitizeFilename(file.original_filename);
    const asciiName = safeName.replace(/[^\x20-\x7e]/g, '_');

    return new Response(object.body, {
      headers: {
        'Content-Type': file.mime_type || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    });
  } finally {
    await db.end();
  }
}

async function handleStatusUpdate(fileId, request, env, session) {
  const { status, comment } = await readJson(request);
  const validStatuses = ['aceptado', 'aceptado_con_observaciones', 'rechazado'];
  if (!validStatuses.includes(status)) return json({ error: 'Estado inválido' }, 400);

  const note = readText(comment, MAX_COMMENT_LENGTH);
  if (note === null) return json({ error: 'Comentario inválido o demasiado largo' }, 400);

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
      [fileId, session.userId, status, note || null]
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
  const { comment } = await readJson(request);
  const text = readText(comment, MAX_COMMENT_LENGTH);
  if (text === null) {
    return json({ error: `El comentario no es válido o supera los ${MAX_COMMENT_LENGTH} caracteres` }, 400);
  }
  if (!text) return json({ error: 'El comentario está vacío' }, 400);

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
  const body = await readJson(request);
  const comment = readText(body.comment, MAX_COMMENT_LENGTH);
  if (comment === null) return json({ error: 'Comentario inválido o demasiado largo' }, 400);

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
      [fileId, session.userId, comment || null]
    );
    return json({ ok: true });
  } finally {
    await db.end();
  }
}

// accept / reject: solo la parte contraria a quien la pidió. cancel: solo quien la pidió.
async function handleDeleteResponse(fileId, request, env, session) {
  const { action, comment } = await readJson(request);
  if (!['accept', 'reject', 'cancel'].includes(action)) return json({ error: 'Acción inválida' }, 400);
  const note = readText(comment, MAX_COMMENT_LENGTH);
  if (note === null) return json({ error: 'Comentario inválido o demasiado largo' }, 400);

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
      [fileId, session.userId, eventType, note || null]
    );
    return json({ ok: true });
  } finally {
    await db.end();
  }
}

// ---------- Endpoints de carpetas ----------

async function handleFolderCreate(request, env, session) {
  const { name, client_id, parent_id } = await readJson(request);

  const folderName = readText(name, MAX_FOLDER_NAME_LENGTH);
  if (folderName === null) {
    return json({ error: `El nombre no es válido o supera los ${MAX_FOLDER_NAME_LENGTH} caracteres` }, 400);
  }
  if (!folderName) return json({ error: 'Falta el nombre' }, 400);

  const parentId = toOptionalId(parent_id);
  if (parentId === undefined) return json({ error: 'parent_id inválido' }, 400);

  const isAdmin = session.role === 'admin';
  let clientId = session.userId;
  if (isAdmin && client_id !== undefined && client_id !== null && client_id !== '') {
    clientId = toId(client_id);
    if (!clientId) return json({ error: 'client_id inválido' }, 400);
  }
  const direction = isAdmin ? 'asesoria_a_cliente' : 'cliente_a_asesoria';

  const db = await getDbConnection(env);
  try {
    if (isAdmin && clientId !== session.userId && !(await clientExists(db, clientId))) {
      return json({ error: 'Cliente no encontrado' }, 404);
    }
    if (parentId && !(await folderBelongsToClient(db, parentId, clientId))) {
      return json({ error: 'La carpeta padre no existe o está archivada' }, 403);
    }

    const [result] = await db.query(
      `INSERT INTO folders (client_id, name, parent_id, direction) VALUES (?, ?, ?, ?)`,
      [clientId, folderName, parentId, direction]
    );

    return json({ ok: true, folderId: result.insertId });
  } finally {
    await db.end();
  }
}

async function handleFolderList(url, env, session) {
  const clientIdParam = toOptionalId(url.searchParams.get('client_id'));
  if (clientIdParam === undefined) return json({ error: 'client_id inválido' }, 400);

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
  const { action } = await readJson(request);
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
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(`${str}T00:00:00Z`);
  return !isNaN(d) && d.toISOString().slice(0, 10) === str;
}

async function handleTaskList(url, env, session) {
  const admin = session.role === 'admin';
  const clientId = admin ? toId(url.searchParams.get('client_id')) : session.userId;
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

  const body = await readJson(request);
  const clientId = toId(body.client_id);
  const title = readText(body.title, 200);
  const description = readText(body.description, 2000);
  const dueDate = body.due_date === undefined || body.due_date === null || body.due_date === ''
    ? null
    : body.due_date;

  if (!clientId) return json({ error: 'Falta client_id' }, 400);
  if (title === null) return json({ error: 'El título no es válido o supera los 200 caracteres' }, 400);
  if (!title) return json({ error: 'La tarea necesita un título' }, 400);
  if (description === null) {
    return json({ error: 'La descripción no es válida o supera los 2000 caracteres' }, 400);
  }
  if (dueDate && !isValidDateString(dueDate)) return json({ error: 'Fecha límite inválida' }, 400);

  const db = await getDbConnection(env);
  try {
    if (!(await clientExists(db, clientId))) return json({ error: 'Cliente no encontrado' }, 404);

    const [result] = await db.query(
      `INSERT INTO tasks (client_id, title, description, due_date, created_by) VALUES (?, ?, ?, ?, ?)`,
      [clientId, title, description || null, dueDate, session.userId]
    );
    return json({ ok: true, taskId: result.insertId });
  } finally {
    await db.end();
  }
}

async function handleTaskStatus(taskId, request, env, session) {
  const { status } = await readJson(request);
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

// ---------- Login ----------

async function handleLogin(request, env) {
  const { username, password } = await readJson(request);

  // Solo strings: un objeto en "username" acabaría expandido dentro del SQL.
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return json({ error: 'Faltan credenciales' }, 400);
  }
  if (username.length > MAX_USERNAME_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return json({ error: 'Usuario o contraseña incorrectos' }, 401);
  }

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

  // Se ejecuta bcrypt siempre (con un hash ficticio si no hay usuario) para que el
  // tiempo de respuesta no delate si el usuario existe.
  const hashToCheck = user?.password_hash || DUMMY_HASH;
  const passwordMatches = await bcrypt.compare(password, hashToCheck);

  if (!user || !user.active || !passwordMatches) {
    return json({ error: 'Usuario o contraseña incorrectos' }, 401);
  }

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

// ---------- Router ----------

const CLEAR_SESSION_COOKIE = 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Defensa extra contra CSRF: las peticiones que modifican datos deben venir de nuestro propio origen.
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const origin = request.headers.get('Origin');
        if (origin) {
          let originHost = null;
          try { originHost = new URL(origin).host; } catch { /* origen inválido */ }
          if (originHost !== url.host) return json({ error: 'Origen no permitido' }, 403);
        }
      }

      // --- Login (público) ---
      if (path === '/api/login' && request.method === 'POST') {
        return await handleLogin(request, env);
      }

      // --- Logout (público) ---
      if (path === '/api/logout' && request.method === 'POST') {
        return json({ ok: true }, 200, { 'Set-Cookie': CLEAR_SESSION_COOKIE });
      }

      // --- Todo lo demás requiere sesión ---
      const cookieSession = await requireSession(request, env);
      if (!cookieSession) return json({ error: 'No autenticado' }, 401);

      // La cookie es válida; se comprueba además que el usuario sigue activo y se toma su rol actual.
      const session = await loadActiveSession(env, cookieSession);
      if (!session) {
        return json({ error: 'No autenticado' }, 401, { 'Set-Cookie': CLEAR_SESSION_COOKIE });
      }

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

      return new Response('Ruta no encontrada', { status: 404 });

    } catch (err) {
      // El detalle va al log del Worker, nunca a la respuesta (podría filtrar SQL, tablas o columnas).
      console.error(err);
      return json({ error: 'Error interno del servidor' }, 500);
    }
  },
};
