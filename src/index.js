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
    'SELECT id FROM folders WHERE id = ? AND client_id = ?',
    [folderId, clientId]
  );
  return rows.length > 0;
}

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
      return json({ error: 'La carpeta indicada no pertenece a este cliente' }, 403);
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
  const direction = url.searchParams.get('direction');
  const folderId = url.searchParams.get('folder_id');
  const clientIdParam = url.searchParams.get('client_id');
  if (!direction) return json({ error: 'Falta direction' }, 400);

  const clientId = session.role === 'admin' && clientIdParam ? clientIdParam : session.userId;

  const db = await getDbConnection(env);
  try {
    const query = folderId
      ? `SELECT * FROM files WHERE client_id = ? AND direction = ? AND folder_id = ? ORDER BY created_at DESC`
      : `SELECT * FROM files WHERE client_id = ? AND direction = ? AND folder_id IS NULL ORDER BY created_at DESC`;
    const params = folderId ? [clientId, direction, folderId] : [clientId, direction];

    const [rows] = await db.query(query, params);
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

    const object = await env.BARBUZANO_FILES.get(file.r2_key);
    if (!object) return json({ error: 'Archivo no encontrado en R2' }, 404);

    if (file.status === 'nuevo') {
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

// ---------- Endpoints de carpetas ----------

async function handleFolderCreate(request, env, session) {
  const { name, client_id, parent_id } = await request.json();
  if (!name) return json({ error: 'Falta el nombre' }, 400);

  const clientId = session.role === 'admin' && client_id ? client_id : session.userId;
  const direction = session.role === 'admin' ? 'asesoria_a_cliente' : 'cliente_a_asesoria';

  const db = await getDbConnection(env);
  try {
    if (parent_id && !(await folderBelongsToClient(db, parent_id, clientId))) {
      return json({ error: 'La carpeta padre no pertenece a este cliente' }, 403);
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
  const direction = url.searchParams.get('direction');
  const clientIdParam = url.searchParams.get('client_id');

  const db = await getDbConnection(env);
  try {
    // Cliente: solo ve sus propias carpetas.
    if (session.role !== 'admin') {
      const query = direction
        ? `SELECT * FROM folders WHERE client_id = ? AND direction = ? ORDER BY name`
        : `SELECT * FROM folders WHERE client_id = ? ORDER BY name`;
      const params = direction ? [session.userId, direction] : [session.userId];
      const [rows] = await db.query(query, params);
      return json(rows);
    }

    // Admin sin client_id: todas las carpetas de todos los clientes,
    // para la pantalla única de administración.
    if (!clientIdParam) {
      const query = direction
        ? `SELECT folders.*, users.username AS client_username
           FROM folders JOIN users ON users.id = folders.client_id
           WHERE folders.direction = ? ORDER BY users.username, folders.name`
        : `SELECT folders.*, users.username AS client_username
           FROM folders JOIN users ON users.id = folders.client_id
           ORDER BY users.username, folders.name`;
      const params = direction ? [direction] : [];
      const [rows] = await db.query(query, params);
      return json(rows);
    }

    // Admin con client_id: carpetas de ese cliente concreto.
    const query = direction
      ? `SELECT * FROM folders WHERE client_id = ? AND direction = ? ORDER BY name`
      : `SELECT * FROM folders WHERE client_id = ? ORDER BY name`;
    const params = direction ? [clientIdParam, direction] : [clientIdParam];
    const [rows] = await db.query(query, params);
    return json(rows);
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

      if (path === '/api/files/upload' && request.method === 'POST') {
        return await handleUpload(request, env, session);
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

      if (path === '/api/folders' && request.method === 'POST') {
        return await handleFolderCreate(request, env, session);
      }

      if (path === '/api/folders' && request.method === 'GET') {
        return await handleFolderList(url, env, session);
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
