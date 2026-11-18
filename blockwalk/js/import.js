/** Paste, CSV, and public Google Sheet links. No network here. */

const ADDRESS_HINT = /address|street|addr|location|full.?name/i;
const LAT_HINT = /^(lat|latitude)$/i;
const LNG_HINT = /^(lng|lon|long|longitude)$/i;
const TYPE_HINT = /location.?type|precision|match.?type/i;
const PARTIAL_HINT = /partial/i;

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function num(value) {
  if (value == null) return null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function looksLikeHeader(row) {
  const joined = row.join(' ').toLowerCase();
  return ADDRESS_HINT.test(joined) || /\blat/.test(joined) || /\blng|\blon/.test(joined);
}

function fromNumbers(lat, lng, address, extra) {
  const stop = {
    address: address || '',
    lat,
    lng,
    status: 'flag',
    flagReason: 'unverified_coordinates',
    locationType: null,
    partialMatch: false,
    placeId: null,
    coordSource: lat == null ? null : 'import',
  };
  if (extra?.locationType) {
    stop.locationType = String(extra.locationType).trim().toUpperCase();
    if (stop.locationType === 'ROOFTOP' && !extra.partialMatch && lat != null && lng != null) {
      stop.status = 'accept';
      stop.flagReason = '';
    } else {
      stop.status = 'flag';
      stop.flagReason = extra.partialMatch ? 'partial_match' : stop.locationType.toLowerCase();
    }
  }
  if (extra?.partialMatch) {
    stop.partialMatch = true;
    stop.status = 'flag';
    stop.flagReason = 'partial_match';
  }
  return stop;
}

export function rowsToStops(rows) {
  if (!rows.length) return [];
  let start = 0;
  let addressCol = 0;
  let latCol = -1;
  let lngCol = -1;
  let typeCol = -1;
  let partialCol = -1;
  if (looksLikeHeader(rows[0])) {
    start = 1;
    rows[0].forEach((cell, i) => {
      const name = cell.trim();
      if (LAT_HINT.test(name)) latCol = i;
      else if (LNG_HINT.test(name)) lngCol = i;
      else if (TYPE_HINT.test(name)) typeCol = i;
      else if (PARTIAL_HINT.test(name)) partialCol = i;
      else if (ADDRESS_HINT.test(name)) addressCol = i;
    });
  }
  const stops = [];
  for (let r = start; r < rows.length; r++) {
    const row = rows[r];
    const address = (row[addressCol] || '').trim();
    const lat = latCol >= 0 ? num(row[latCol]) : null;
    const lng = lngCol >= 0 ? num(row[lngCol]) : null;
    if (!address && lat == null) continue;
    const partial = partialCol >= 0 && /^(1|true|yes)$/i.test(String(row[partialCol] || '').trim());
    const locationType = typeCol >= 0 ? row[typeCol] : null;
    if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      stops.push(fromNumbers(lat, lng, address, { locationType, partialMatch: partial }));
    } else if (address) {
      stops.push({
        address,
        lat: null,
        lng: null,
        status: 'flag',
        flagReason: 'needs_geocode',
        locationType: null,
        partialMatch: false,
        placeId: null,
        coordSource: null,
      });
    }
  }
  return stops;
}

const LATLNG = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

export function parseFreeformLine(line) {
  const text = line.trim();
  const only = text.match(LATLNG);
  if (only) {
    const lat = Number(only[1]);
    const lng = Number(only[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return fromNumbers(lat, lng, '', null);
  }
  const csv = parseCsv(text)[0] || [text];
  if (csv.length >= 3) {
    const lat = num(csv[csv.length - 2]);
    const lng = num(csv[csv.length - 1]);
    if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      const address = csv.slice(0, -2).join(',').trim();
      return fromNumbers(lat, lng, address, null);
    }
  }
  return {
    address: text,
    lat: null,
    lng: null,
    status: 'flag',
    flagReason: 'needs_geocode',
    locationType: null,
    partialMatch: false,
    placeId: null,
    coordSource: null,
  };
}

export function parsePaste(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const headerish = looksLikeHeader(lines[0].split(','));
  const commas = lines.filter((l) => l.includes(',')).length;
  if (headerish || (lines.length > 1 && commas >= lines.length * 0.8 && lines[0].split(',').length >= 3)) {
    return rowsToStops(parseCsv(text));
  }
  return lines.map(parseFreeformLine);
}

export function toSheetCsvUrl(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw new Error('That is not a URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Use an http(s) link.');
  const csvish = url.pathname.endsWith('.csv')
    || url.searchParams.get('format') === 'csv'
    || url.searchParams.get('output') === 'csv'
    || url.searchParams.get('tqx') === 'out:csv';
  if (url.hostname !== 'docs.google.com') {
    if (csvish) return url.toString();
    throw new Error('Use a Google Sheet link or a direct CSV link.');
  }
  const m = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!m) throw new Error('That Sheet link has no spreadsheet id.');
  if (url.pathname.includes('/pub')) {
    url.searchParams.set('output', 'csv');
    url.hash = '';
    return url.toString();
  }
  let gid = url.searchParams.get('gid') || '0';
  const hashGid = (url.hash || '').match(/gid=(\d+)/);
  if (hashGid) gid = hashGid[1];
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${encodeURIComponent(gid)}`;
}
