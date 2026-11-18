/** Calls the Cloudflare Worker. The browser never sees the service account. */

async function workerRequest(settings, path, body, method = 'POST') {
  const base = String(settings.workerUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('Set the Worker URL in Settings.');
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-blockwalk-passcode': settings.passcode || '',
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 180) };
  }
  if (!res.ok) {
    const err = new Error(data?.error || `Worker responded ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function workerHealth(settings) {
  return workerRequest(settings, '/health', null, 'GET');
}

export async function optimizeRemote(settings, spec, onProgress) {
  const started = await workerRequest(settings, '/optimize', spec);
  if (started.done && started.response) return started.response;
  if (started.error) throw new Error(started.error.message || started.error);
  if (!started.operation) throw new Error('Solver did not return a route.');
  const budget = (spec.timeoutSeconds || 45) + 30;
  const startedAt = Date.now();
  const deadline = startedAt + budget * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    onProgress?.(Math.round((Date.now() - startedAt) / 1000));
    const polled = await workerRequest(settings, '/optimize/poll', { operation: started.operation });
    if (polled.error) throw new Error(polled.error.message || polled.error);
    if (polled.done && polled.response) return polled.response;
  }
  throw new Error('The solver did not finish before the timeout.');
}

export function geocodeRemote(settings, addresses, placeIds) {
  return workerRequest(settings, '/geocode', { addresses, placeIds });
}

export function validateRemote(settings, address) {
  return workerRequest(settings, '/validate', { address, regionCode: 'US' });
}

export function insightsRemote(settings, lat, lng) {
  return workerRequest(settings, '/solar/insights', { lat, lng });
}

export function layersRemote(settings, lat, lng) {
  return workerRequest(settings, '/solar/layers', { lat, lng, radiusMeters: 100 });
}

export function teslaRemote(settings, lat, lng, label) {
  return workerRequest(settings, '/tesla', { lat, lng, label });
}

export function sheetRemote(settings, url) {
  return workerRequest(settings, '/sheet', { url });
}
