/**
 * Blockwalk Worker.
 * Holds the Google service account, the server Maps key, and the Tessie token.
 * The phone sends a passcode. Nothing here is a secret default — set Wrangler secrets.
 *
 * Routes (all require X-Blockwalk-Passcode except OPTIONS):
 *   GET  /health
 *   POST /optimize          Route Optimization, one vehicle
 *   POST /optimize/poll     poll a long-running operation
 *   POST /geocode           batch up to 40
 *   POST /validate          Address Validation
 *   POST /solar/insights    buildingInsights
 *   POST /solar/layers      dataLayers annual flux, proxied so the phone can read it
 *   POST /tesla             Tessie share-to-car
 *   POST /sheet             public Google Sheet CSV proxy
 */

import { googleAccessToken } from './auth.js';
import { buildOptimizeRequest, solverTimeoutSeconds, useLongRunning } from '../../js/optimize-request.js';

const ROUTE_OPT = 'https://routeoptimization.googleapis.com/v1';

function corsHeaders(origin, env) {
  const allow = originAllowed(origin, env) ? origin : 'https://magger1024.github.io';
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-blockwalk-passcode',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function originAllowed(origin, env) {
  if (!origin) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  const list = String(env.ALLOWED_ORIGINS || 'https://magger1024.github.io').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin);
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const aa = enc.encode(String(a));
  const bb = enc.encode(String(b));
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function json(data, status, origin, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(origin, env) },
  });
}

function bytesToB64(bytes) {
  let s = '';
  const view = new Uint8Array(bytes);
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) s += String.fromCharCode(...view.subarray(i, i + chunk));
  return btoa(s);
}

function operationAllowed(name) {
  return typeof name === 'string' && /^projects\/[A-Za-z0-9._:-]+\/(?:locations\/[A-Za-z0-9._:-]+\/)?operations\/[A-Za-z0-9._:-]+$/.test(name);
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > 2_000_000) throw new Error('Request is too large.');
  if (!text) return {};
  return JSON.parse(text);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    if (origin && !originAllowed(origin, env)) return json({ error: 'Origin is not allowed.' }, 403, origin, env);
    if (!env.PASSCODE) return json({ error: 'Worker PASSCODE secret is not set.' }, 503, origin, env);
    if (!safeEqual(request.headers.get('x-blockwalk-passcode') || '', env.PASSCODE)) {
      return json({ error: 'Passcode was rejected.' }, 401, origin, env);
    }
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/health') return health(env, origin);
      if (request.method !== 'POST') return json({ error: 'Not found.' }, 404, origin, env);
      const body = await readBody(request);
      if (url.pathname === '/health') return health(env, origin);
      if (url.pathname === '/optimize') return optimize(env, body, origin);
      if (url.pathname === '/optimize/poll') return poll(env, body, origin);
      if (url.pathname === '/geocode') return geocode(env, body, origin);
      if (url.pathname === '/validate') return validate(env, body, origin);
      if (url.pathname === '/solar/insights') return insights(env, body, origin);
      if (url.pathname === '/solar/layers') return layers(env, body, origin);
      if (url.pathname === '/tesla') return tesla(env, body, origin);
      if (url.pathname === '/sheet') return sheet(body, origin, env);
      return json({ error: 'Not found.' }, 404, origin, env);
    } catch (err) {
      return json({ error: err.message || 'Worker error.' }, 400, origin, env);
    }
  },
};

function health(env, origin) {
  const maps = Boolean(env.GOOGLE_MAPS_API_KEY);
  return json({
    ok: true,
    optimize: Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON && env.GOOGLE_CLOUD_PROJECT),
    geocode: maps,
    validate: maps,
    solar: maps,
    tessie: Boolean(env.TESSIE_API_TOKEN && env.TESSIE_VIN),
  }, 200, origin, env);
}

async function optimize(env, spec, origin) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || !env.GOOGLE_CLOUD_PROJECT) {
    return json({ error: 'Route Optimization is not configured on the worker.' }, 503, origin, env);
  }
  const timeoutSeconds = spec.timeoutSeconds || solverTimeoutSeconds((spec.parkPoints || []).length);
  const requestBody = buildOptimizeRequest({ ...spec, timeoutSeconds });
  const token = await googleAccessToken(env);
  const parent = `projects/${env.GOOGLE_CLOUD_PROJECT}`;
  const longRunning = useLongRunning((spec.parkPoints || []).length, timeoutSeconds);
  const endpoint = longRunning ? 'optimizeToursLongRunning' : 'optimizeTours';
  const res = await fetch(`${ROUTE_OPT}/${parent}:${endpoint}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  const data = await res.json();
  if (!res.ok) return json({ error: data.error?.message || 'Route Optimization rejected the request.' }, res.status, origin, env);
  if (longRunning) {
    return json({ done: Boolean(data.done), operation: data.name || null, response: data.response || null, error: data.error || null }, 200, origin, env);
  }
  return json({ done: true, operation: null, response: data }, 200, origin, env);
}

async function poll(env, body, origin) {
  if (!operationAllowed(body.operation)) return json({ error: 'Unknown operation.' }, 400, origin, env);
  const token = await googleAccessToken(env);
  const res = await fetch(`${ROUTE_OPT}/${body.operation}`, { headers: { authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) return json({ error: data.error?.message || 'Could not poll the solver.' }, res.status, origin, env);
  if (data.error) return json({ error: data.error.message || 'Solver failed.', done: true }, 502, origin, env);
  return json({ done: Boolean(data.done), operation: data.name || body.operation, response: data.response || null }, 200, origin, env);
}

async function geocode(env, body, origin) {
  if (!env.GOOGLE_MAPS_API_KEY) return json({ error: 'Server Maps key is not configured.' }, 503, origin, env);
  const addresses = Array.isArray(body.addresses) ? body.addresses.slice(0, 40) : [];
  const placeIds = Array.isArray(body.placeIds) ? body.placeIds.slice(0, 40) : [];
  if (addresses.length + placeIds.length > 40) return json({ error: 'Geocode at most 40 records per call.' }, 400, origin, env);
  const jobs = [
    ...addresses.map((address) => ({ kind: 'address', query: String(address || '') })),
    ...placeIds.map((placeId) => ({ kind: 'placeId', query: String(placeId || '') })),
  ];
  const results = await Promise.all(jobs.map(async (job) => {
    const params = new URLSearchParams({ key: env.GOOGLE_MAPS_API_KEY });
    if (job.kind === 'placeId') params.set('place_id', job.query);
    else params.set('address', job.query);
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
    const data = await res.json();
    const top = (data.results || [])[0] || null;
    return {
      kind: job.kind,
      query: job.query,
      status: data.status || 'UNKNOWN',
      result: top ? {
        place_id: top.place_id || null,
        formatted_address: top.formatted_address || '',
        partial_match: Boolean(top.partial_match),
        types: top.types || [],
        geometry: {
          location_type: top.geometry?.location_type || '',
          location: top.geometry?.location || null,
        },
      } : null,
    };
  }));
  return json({ results }, 200, origin, env);
}

async function validate(env, body, origin) {
  if (!env.GOOGLE_MAPS_API_KEY) return json({ error: 'Server Maps key is not configured.' }, 503, origin, env);
  const address = String(body.address || '').trim();
  if (!address) return json({ error: 'Address is required.' }, 400, origin, env);
  const res = await fetch(`https://addressvalidation.googleapis.com/v1:validateAddress?key=${encodeURIComponent(env.GOOGLE_MAPS_API_KEY)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: { regionCode: body.regionCode || 'US', addressLines: [address] } }),
  });
  const data = await res.json();
  if (!res.ok) return json({ error: data.error?.message || 'Address Validation failed.' }, res.status, origin, env);
  return json(data, 200, origin, env);
}

async function insights(env, body, origin) {
  if (!env.GOOGLE_MAPS_API_KEY) return json({ error: 'Server Maps key is not configured.' }, 503, origin, env);
  const params = new URLSearchParams({
    'location.latitude': String(body.lat),
    'location.longitude': String(body.lng),
    requiredQuality: 'LOW',
    key: env.GOOGLE_MAPS_API_KEY,
  });
  const res = await fetch(`https://solar.googleapis.com/v1/buildingInsights:findClosest?${params}`);
  const data = await res.json();
  if (!res.ok) return json({ error: data.error?.message || 'No building insights.', code: data.error?.status || res.status }, res.status, origin, env);
  return json(data, 200, origin, env);
}

async function layers(env, body, origin) {
  if (!env.GOOGLE_MAPS_API_KEY) return json({ error: 'Server Maps key is not configured.' }, 503, origin, env);
  const params = new URLSearchParams({
    'location.latitude': String(body.lat),
    'location.longitude': String(body.lng),
    radiusMeters: String(body.radiusMeters || 100),
    view: 'IMAGERY_AND_ANNUAL_FLUX_LAYERS',
    requiredQuality: 'LOW',
    pixelSizeMeters: '0.5',
    key: env.GOOGLE_MAPS_API_KEY,
  });
  const res = await fetch(`https://solar.googleapis.com/v1/dataLayers:get?${params}`);
  const data = await res.json();
  if (!res.ok) return json({ error: data.error?.message || 'No solar layers.' }, res.status, origin, env);
  if (!data.annualFluxUrl) return json({ error: 'Solar response had no annual flux raster.' }, 502, origin, env);
  const tiff = await fetch(data.annualFluxUrl);
  if (!tiff.ok) return json({ error: 'Could not download the flux raster.' }, 502, origin, env);
  const buf = await tiff.arrayBuffer();
  return json({
    imageryDate: data.imageryDate || null,
    imageryQuality: data.imageryQuality || null,
    annualFluxBase64: bytesToB64(buf),
  }, 200, origin, env);
}

async function tesla(env, body, origin) {
  if (!env.TESSIE_API_TOKEN || !env.TESSIE_VIN) {
    return json({ error: 'Tessie is not configured on the worker.' }, 409, origin, env);
  }
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: 'lat and lng are required.' }, 400, origin, env);
  const params = new URLSearchParams({
    value: `${lat},${lng}`,
    locale: 'en-US',
    wait_for_completion: 'true',
  });
  const res = await fetch(`https://api.tessie.com/${encodeURIComponent(env.TESSIE_VIN)}/command/share?${params}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.TESSIE_API_TOKEN}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.result === false) {
    return json({ error: data.error || data.message || 'Tessie did not accept the destination.' }, res.status || 502, origin, env);
  }
  return json({ ok: true, result: data.result !== false }, 200, origin, env);
}

async function sheet(body, origin, env) {
  let url;
  try {
    url = new URL(String(body.url || ''));
  } catch {
    return json({ error: 'Sheet URL is invalid.' }, 400, origin, env);
  }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || !url.pathname.includes('/spreadsheets/')) {
    return json({ error: 'Only public Google Sheet links can be fetched.' }, 400, origin, env);
  }
  const res = await fetch(url.toString(), { redirect: 'follow' });
  if (!res.ok) return json({ error: `Sheet responded ${res.status}. Publish the sheet or share it as anyone with the link.` }, 502, origin, env);
  const csv = await res.text();
  if (csv.length > 4_000_000) return json({ error: 'That sheet is too large to pull in one call.' }, 413, origin, env);
  return json({ csv }, 200, origin, env);
}
