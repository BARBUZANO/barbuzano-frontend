import { verifySession } from '../_lib/session.js';

export async function onRequest(context) {
  const session = await verifySession(context.request, context.env.SESSION_SECRET);

  if (!session) {
    // Sin sesión válida: fuera de aquí, de vuelta al home.
    return Response.redirect(new URL('/', context.request.url).toString(), 302);
  }

  // Sesión válida: dejamos pasar la petición hacia clientes/index.html (o lo que venga después).
  return context.next();
}
