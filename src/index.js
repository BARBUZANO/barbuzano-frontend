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
      return json({ error: 'La carpeta indicada no existe o no está disponible' }, 403);
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
      return json({ error: 'La carpeta padre no existe o no está disponible' }, 403);
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
        `SELECT folders.*, users.username AS client_username, ru.role AS delete_requested_by_role
         FROM folders JOIN users ON users.id = folders.client_id
         LEFT JOIN users ru ON ru.id = folders.delete_requested_by
         WHERE folders.status <> 'eliminada'
         ORDER BY users.username, folders.name`
      );
      return json(rows);
    }

    // Cliente: solo las suyas. Admin con client_id: las de ese cliente.
    const clientId = session.role === 'admin' ? clientIdParam : session.userId;
    const [rows] = await db.query(
      `SELECT folders.*, ru.role AS delete_requested_by_role
       FROM folders LEFT JOIN users ru ON ru.id = folders.delete_requested_by
       WHERE folders.client_id = ? AND folders.status <> 'eliminada'
       ORDER BY folders.name`,
      [clientId]
    );
    return json(rows);
  } finally {
    await db.end();
  }
}

// ---------- Eliminación de carpetas (doble verificación, igual que los archivos) ----------

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

// Una carpeta solo se puede eliminar si no contiene archivos ni subcarpetas activos.
async function folderIsEmpty(db, folderId) {
  const [files] = await db.query(
    "SELECT COUNT(*) AS n FROM files WHERE folder_id = ? AND status <> 'eliminado'",
    [folderId]
  );
  const [subs] = await db.query(
    "SELECT COUNT(*) AS n FROM folders WHERE parent_id = ? AND status <> 'eliminada'",
    [folderId]
  );
  return Number(files[0].n) === 0 && Number(subs[0].n) === 0;
}

const FOLDER_NOT_EMPTY = 'La carpeta debe estar vacía: elimina antes los archivos que contiene.';

// Cualquiera de las dos partes puede pedir la eliminación; la otra debe confirmarla.
async function handleFolderDeleteRequest(folderId, env, session) {
  const db = await getDbConnection(env);
  try {
    const { folder, error } = await loadAccessibleFolder(db, folderId, session);
    if (error) return error;
    if (folder.status !== 'activa') {
      return json({ error: 'La eliminación de esta carpeta ya está solicitada' }, 409);
    }
    if (!(await folderIsEmpty(db, folderId))) return json({ error: FOLDER_NOT_EMPTY }, 409);

    const [result] = await db.query(
      `UPDATE folders SET status = 'eliminacion_solicitada', delete_requested_by = ?, delete_requested_at = NOW()
       WHERE id = ? AND status = 'activa'`,
      [session.userId, folderId]
    );
    if (result.affectedRows === 0) return json({ error: 'La carpeta ha cambiado, recarga' }, 409);
    return json({ ok: true });
  } finally {
    await db.end();
  }
}

// accept / reject: solo la parte contraria a quien la pidió. cancel: solo quien la pidió.
async function handleFolderDeleteResponse(folderId, request, env, session) {
  const { action } = await request.json();
  if (!['accept', 'reject', 'cancel'].includes(action)) return json({ error: 'Acción inválida' }, 400);

  const db = await getDbConnection(env);
  try {
    const { folder, error } = await loadAccessibleFolder(db, folderId, session);
    if (error) return error;
    if (folder.status !== 'eliminacion_solicitada') {
      return json({ error: 'Esta carpeta no tiene una eliminación pendiente' }, 409);
    }

    const [users] = await db.query('SELECT role FROM users WHERE id = ?', [folder.delete_requested_by]);
    const requesterIsAdmin = users[0]?.role === 'admin';
    const sameSide = requesterIsAdmin === (session.role === 'admin');

    if (action === 'cancel' && !sameSide) {
      return json({ error: 'Solo quien pidió la eliminación puede cancelarla' }, 403);
    }
    if (action !== 'cancel' && sameSide) {
      return json({ error: 'La eliminación debe confirmarla la otra parte' }, 403);
    }

    let result;
    if (action === 'accept') {
      // Se vuelve a comprobar: pudo subirse algo mientras la solicitud estaba pendiente.
      if (!(await folderIsEmpty(db, folderId))) return json({ error: FOLDER_NOT_EMPTY }, 409);
      [result] = await db.query(
        `UPDATE folders SET status = 'eliminada', deleted_at = NOW()
         WHERE id = ? AND status = 'eliminacion_solicitada'`,
        [folderId]
      );
    } else {
      [result] = await db.query(
        `UPDATE folders SET status = 'activa', delete_requested_by = NULL, delete_requested_at = NULL
         WHERE id = ? AND status = 'eliminacion_solicitada'`,
        [folderId]
      );
    }
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

      const folderDeleteRequestMatch = path.match(/^\/api\/folders\/(\d+)\/delete-request$/);
      if (folderDeleteRequestMatch && request.method === 'POST') {
        return await handleFolderDeleteRequest(folderDeleteRequestMatch[1], env, session);
      }

      const folderDeleteResponseMatch = path.match(/^\/api\/folders\/(\d+)\/delete-response$/);
      if (folderDeleteResponseMatch && request.method === 'POST') {
        return await handleFolderDeleteResponse(folderDeleteResponseMatch[1], request, env, session);
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
