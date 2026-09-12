import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { createSessionCookie } from '../_lib/session.js';

async function getDbConnection(env) {
  return await mysql.createConnection({
    host: env.HYPERDRIVE.host,
    user: env.HYPERDRIVE.user,
    password: env.HYPERDRIVE.password,
    database: env.HYPERDRIVE.database,
    port: env.HYPERDRIVE.port,

    // Obligatorio en Cloudflare Workers/Pages: fuerza el parser estático de
    // mysql2 en vez del que usa new Function()/eval(), que el runtime bloquea.
    disableEval: true,
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { username, password } = await request.json();

    if (!username || !password) {
      return Response.json({ error: 'Faltan credenciales' }, { status: 400 });
    }

    const db = await getDbConnection(env);
    const [rows] = await db.query(
      'SELECT id, username, password_hash, active FROM users WHERE username = ?',
      [username]
    );
    await db.end();

    const user = rows[0];

    if (!user || !user.active) {
      return Response.json({ error: 'Usuario o contraseña incorrectos' }, { status: 401 });
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatches) {
      return Response.json({ error: 'Usuario o contraseña incorrectos' }, { status: 401 });
    }

    const cookie = await createSessionCookie(user, env.SESSION_SECRET);

    return new Response(
      JSON.stringify({
        message: 'Autenticación exitosa',
        user: { id: user.id, username: user.username },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': cookie,
        },
      }
    );
  } catch (err) {
    return Response.json(
      { error: 'Error interno del servidor', details: err.message },
      { status: 500 }
    );
  }
}
