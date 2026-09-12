// Sesión mediante cookie firmada (HMAC-SHA256), sin tabla de sesiones en MySQL.
// El payload (uid, username, expiración) va codificado en la propia cookie,
// firmado con SESSION_SECRET para que no se pueda falsificar ni modificar.

const SESSION_DURATION_SECONDS = 60 * 60 * 8; // 8 horas

function base64UrlEncode(bytes) {
  const str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  return new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
}

async function hmacSign(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(signatureBuffer));
}

// Genera la cabecera Set-Cookie tras un login correcto.
export async function createSessionCookie(user, secret) {
  const payload = JSON.stringify({
    uid: user.id,
    username: user.username,
    exp: Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS,
  });
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(payload));
  const signature = await hmacSign(encodedPayload, secret);
  const token = `${encodedPayload}.${signature}`;

  return `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DURATION_SECONDS}`;
}

// Cabecera Set-Cookie para cerrar sesión (borra la cookie).
export function clearSessionCookie() {
  return 'session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}

// Devuelve el payload de la sesión si la cookie es válida y no ha expirado, o null si no.
export async function verifySession(request, secret) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)session=([^;]+)/);
  if (!match) return null;

  const [encodedPayload, signature] = match[1].split('.');
  if (!encodedPayload || !signature) return null;

  const expectedSignature = await hmacSign(encodedPayload, secret);
  if (expectedSignature !== signature) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload)));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
