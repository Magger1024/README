/** Service-account OAuth for Route Optimization. Token cached in the isolate and the Cache API. */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

let memory = null;

function bytesToB64url(bytes) {
  let s = '';
  const chunk = 0x8000;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += chunk) {
    s += String.fromCharCode(...view.subarray(i, i + chunk));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pemToPkcs8(pem) {
  const b64 = String(pem).replace(/-----BEGIN PRIVATE KEY-----/g, '').replace(/-----END PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function mintToken(env) {
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  if (!sa.client_email || !sa.private_key) throw new Error('Service account JSON is missing client_email or private_key.');
  const now = Math.floor(Date.now() / 1000);
  const header = bytesToB64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = bytesToB64url(new TextEncoder().encode(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })));
  const unsigned = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${bytesToB64url(sig)}`;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Google token request failed.');
  return { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
}

export async function googleAccessToken(env) {
  const now = Date.now();
  if (memory && memory.exp > now + 60_000) return memory.token;
  const cacheKey = new Request('https://blockwalk.internal/google-token');
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) {
      const exp = Number(hit.headers.get('x-exp') || 0);
      if (exp > now + 60_000) {
        const token = await hit.text();
        memory = { token, exp };
        return token;
      }
    }
  } catch {
    /* Cache API is best-effort. The isolate cache still helps. */
  }
  const minted = await mintToken(env);
  memory = minted;
  try {
    await caches.default.put(cacheKey, new Response(minted.token, {
      headers: { 'x-exp': String(minted.exp), 'cache-control': 'private, max-age=3000' },
    }));
  } catch {
    /* ignore */
  }
  return minted.token;
}
