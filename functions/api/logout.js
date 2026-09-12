import { clearSessionCookie } from '../_lib/session.js';

export async function onRequestPost() {
  return new Response(JSON.stringify({ message: 'Sesión cerrada' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearSessionCookie(),
    },
  });
}
