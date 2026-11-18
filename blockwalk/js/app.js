/**
 * Blockwalk UI. Opens on a full-screen map. Demo mode needs no API keys:
 * a fictional list and the on-phone optimizer.
 */

import { openDb, kvGet, kvSet } from './db.js';
import { CanvasMap } from './map.js';
import { attachAutocomplete, mountGoogleMap } from './gmaps.js';
import { demoStops, demoStart } from './sample.js';
import { parsePaste, toSheetCsvUrl } from './import.js';
import { classifyGeocodeResult, classifyValidation, applyGeocode, applyManualPin, refreshStaleStop } from './geocode.js';
import { splitIntoDays, rollForward } from './split.js';
import { assessUsage, applyAdd, emptyUsage, rollUsage, standingWarnings, LIMITS } from './costs.js';
import { blockers, buildParkPoints, localRoute, optimizableStops, orderParksFromIds, routeStats, statsLine, flattenedStops, moveVisit, nextTarget, lockParksFromCurrent } from './route.js';
import { buildOptimizeRequest, readOptimizeResponse, solverTimeoutSeconds } from './optimize-request.js';
import { navLinks } from './nav.js';
import { suggestRevisit, learnedMinutes, dueRevisits } from './time.js';
import { SOLAR_ATTRIBUTION, isStreetZoom, cacheFresh, overlayKey, summarizeInsight, demoFlux, fluxToRgba, SOLAR_MAX_AGE_MS } from './solar.js';
import { decodeGeotiff } from './geotiff.js';
import { geocodeRemote, insightsRemote, layersRemote, optimizeRemote, sheetRemote, teslaRemote, validateRemote, workerHealth } from './api.js';

const DEFAULTS = {
  mapsKey: '',
  workerUrl: '',
  passcode: '',
  minutesPerDoor: 3,
  doorsPerDay: 150,
  walkMeters: 150,
  departureTime: '10:00',
  avoidUTurns: false,
};

const state = {
  db: null,
  settings: { ...DEFAULTS },
  stops: [],
  days: [],
  activeDay: 0,
  route: null,
  usage: emptyUsage(),
  knocks: [],
  me: null,
  startMode: 'me',
  startPlace: null,
  endMode: 'start',
  endPlace: null,
  sunOn: false,
  base: 'map',
  showAreas: false,
  selectedId: null,
  tab: 'stops',
  snap: 'peek',
  picking: null,
  health: null,
  flux: null,
  forceOptimize: false,
  saves: 0,
  sample: false,
};

const $ = (id) => document.getElementById(id);
let map;
let googleMap = null;
let toastTimer = 0;
let viewTimer = 0;

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.textContent = ''; }, 4200);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function workerReady() {
  return Boolean(state.settings.workerUrl && state.settings.passcode);
}

function demoMode() {
  return state.sample || !workerReady();
}

function dayStops() {
  const day = state.days[state.activeDay];
  const ids = new Set(day ? day.stopIds : state.stops.map((s) => s.id));
  return state.stops.filter((s) => ids.has(s.id) || (state.activeDay === 0 && s.lat == null));
}

function currentStart() {
  if (state.startMode === 'place' && state.startPlace) return state.startPlace;
  if (state.me) return state.me;
  if (state.sample || state.stops.some((s) => s.coordSource === 'sample')) return demoStart();
  return null;
}

function currentEnd() {
  if (state.endMode === 'place' && state.endPlace) return state.endPlace;
  return currentStart();
}

function startLabel() {
  if (state.startMode === 'place' && state.startPlace) return state.startPlace.address || 'Chosen place';
  if (state.me) return 'Current location';
  if (state.sample || state.stops.some((s) => s.coordSource === 'sample')) return 'Demo location';
  return 'Current location';
}

function endLabel() {
  if (state.endMode === 'place' && state.endPlace) return state.endPlace.address || 'Chosen place';
  return 'Same as start';
}

function departureISO() {
  const [h, m] = String(state.settings.departureTime || '10:00').split(':').map((n) => Number(n) || 0);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

function setSnap(snap) {
  state.snap = snap;
  const h = snap === 'full' ? Math.round(window.innerHeight * 0.92) : snap === 'half' ? Math.round(window.innerHeight * 0.62) : 312;
  document.documentElement.style.setProperty('--sheet-h', `${h}px`);
}

async function save() {
  if (!state.db) return;
  const payload = {
    v: 1,
    settings: state.settings,
    stops: state.stops,
    days: state.days,
    activeDay: state.activeDay,
    route: state.route,
    usage: state.usage,
    knocks: state.knocks,
    startMode: state.startMode,
    startPlace: state.startPlace,
    endMode: state.endMode,
    endPlace: state.endPlace,
    sample: state.sample,
  };
  await kvSet(state.db, 'state', payload);
  state.saves += 1;
  document.body.dataset.saves = String(state.saves);
}

function hydrate(saved) {
  if (!saved || saved.v !== 1) return;
  state.settings = { ...DEFAULTS, ...(saved.settings || {}) };
  state.stops = (saved.stops || []).map((s) => refreshStaleStop(s, Date.now()));
  state.days = saved.days || [];
  state.activeDay = saved.activeDay || 0;
  state.route = saved.route || null;
  state.usage = rollUsage(saved.usage || emptyUsage(), new Date());
  state.knocks = saved.knocks || [];
  state.startMode = saved.startMode || 'me';
  state.startPlace = saved.startPlace || null;
  state.endMode = saved.endMode || 'start';
  state.endPlace = saved.endPlace || null;
  state.sample = Boolean(saved.sample);
}

function assignDays() {
  const located = state.stops.filter((s) => s.lat != null && !s.skipped);
  state.days = splitIntoDays(located, state.settings.doorsPerDay);
  if (!state.days.length) state.days = [{ index: 0, stopIds: [] }];
  const placed = new Set();
  state.days.forEach((day, index) => {
    day.index = index;
    for (const id of day.stopIds) {
      placed.add(id);
      const stop = state.stops.find((s) => s.id === id);
      if (stop) stop.dayIndex = index;
    }
  });
  for (const stop of state.stops) {
    if (!placed.has(stop.id)) stop.dayIndex = 0;
  }
  if (state.activeDay >= state.days.length) state.activeDay = 0;
}

function newId() {
  return `stop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeImported(raw) {
  return raw.map((row) => ({
    id: newId(),
    address: row.address || 'Dropped pin',
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    placeId: row.placeId || null,
    locationType: row.locationType || null,
    partialMatch: Boolean(row.partialMatch),
    status: row.status || 'flag',
    flagReason: row.flagReason || '',
    coordSource: row.coordSource || null,
    geocodedAt: row.geocodedAt || null,
    disposition: null,
    disposedAt: null,
    revisitAt: null,
    skipped: false,
    locked: false,
    knocked: false,
    dayIndex: 0,
  }));
}

async function geocodeNeeded(stops) {
  if (!workerReady()) return;
  const pending = stops.filter((s) => s.flagReason === 'needs_geocode' || s.flagReason === 'stale_coordinates');
  if (!pending.length) return;
  for (let i = 0; i < pending.length; i += 40) {
    const batch = pending.slice(i, i + 40);
    const gate = assessUsage(state.usage, { geocodes: batch.length });
    if (gate.warnings.some((w) => w.level === 'over') && !state.forceGeo) {
      state.forceGeo = true;
      toast(`${gate.warnings[0].message} Import again to continue past the free tier.`);
      return;
    }
    const byAddress = batch.filter((s) => s.flagReason !== 'stale_coordinates' || !s.placeId);
    const byPlace = batch.filter((s) => s.flagReason === 'stale_coordinates' && s.placeId);
    const data = await geocodeRemote(state.settings, byAddress.map((s) => s.address), byPlace.map((s) => s.placeId));
    (data.results || []).forEach((row, index) => {
      const stop = index < byAddress.length ? byAddress[index] : byPlace[index - byAddress.length];
      const classified = row.result ? classifyGeocodeResult(row.result) : {
        status: 'flag', reason: 'not_found', lat: null, lng: null, placeId: stop.placeId, locationType: null,
      };
      Object.assign(stop, applyGeocode(stop, classified, Date.now(), 'google'));
    });
    state.usage = applyAdd(state.usage, { geocodes: batch.length });
    toast(`Geocoded ${Math.min(i + batch.length, pending.length)} of ${pending.length}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function addStops(raw, { sample = false } = {}) {
  const stops = sample ? raw : normalizeImported(raw);
  if (!sample) await geocodeNeeded(stops);
  state.stops = sample ? stops : state.stops.concat(stops);
  state.sample = sample ? true : state.sample && state.stops.every((s) => s.coordSource === 'sample');
  if (sample) {
    state.route = null;
    state.startMode = 'me';
    state.endMode = 'start';
    state.startPlace = null;
    state.endPlace = null;
  }
  assignDays();
  state.route = null;
  await save();
  render();
  const points = state.stops.filter((s) => s.lat != null);
  const pad = { top: 130, bottom: 340, left: 28, right: 72 };
  map.fit(points, pad);
  if (googleMap) googleMap.fit(points);
  const flagged = stops.filter((s) => s.status === 'flag').length;
  if (flagged) toast(`${flagged} ${flagged === 1 ? 'pin needs' : 'pins need'} a rooftop fix before Optimize.`);
}

async function onOptimize() {
  const stops = dayStops();
  const flagged = blockers(stops);
  if (flagged.length) {
    state.selectedId = flagged[0].id;
    state.base = 'satellite';
    toast(`${flagged.length} ${flagged.length === 1 ? 'pin is' : 'pins are'} not rooftop. Drag ${flagged.length === 1 ? 'it' : 'them'} on satellite, or run Address Validation.`);
    render();
    return;
  }
  const pool = optimizableStops(stops);
  if (!pool.length) {
    toast('Nothing left to route. Skipped and knocked doors stay out.');
    return;
  }
  const start = currentStart();
  const end = currentEnd();
  if (!start || !end) {
    toast('Set a start. Allow location, or long-press the map.');
    return;
  }
  let parks = buildParkPoints(pool, {
    minutesPerDoor: Number(state.settings.minutesPerDoor) || 3,
    walkMeters: Number(state.settings.walkMeters) || 150,
  });
  parks = lockParksFromCurrent(parks, state.route?.parkIds);
  if (workerReady()) {
    const gate = assessUsage(state.usage, { routeStops: parks.length });
    if (gate.warnings.some((w) => w.level === 'over') && !state.forceOptimize) {
      state.forceOptimize = true;
      $('btn-optimize').textContent = 'Optimize anyway';
      toast(gate.warnings[0].message);
      render();
      return;
    }
    try {
      $('btn-optimize').textContent = 'Solving…';
      const spec = {
        departureTime: departureISO(),
        start: { lat: start.lat, lng: start.lng },
        end: { lat: end.lat, lng: end.lng },
        avoidUTurns: Boolean(state.settings.avoidUTurns),
        timeoutSeconds: solverTimeoutSeconds(parks.length),
        parkPoints: parks.map((p) => ({
          id: p.id,
          lat: p.park.lat,
          lng: p.park.lng,
          serviceSeconds: p.serviceSeconds,
          sideOfRoad: p.sideOfRoad,
          heading: p.heading,
          locked: p.locked,
        })),
      };
      buildOptimizeRequest(spec);
      const response = await optimizeRemote(state.settings, spec, (sec) => {
        $('btn-optimize').textContent = `Solving… ${sec}s`;
      });
      const read = readOptimizeResponse(response, spec.parkPoints);
      const ordered = orderParksFromIds(parks, read.order);
      state.route = {
        engine: 'google',
        parkIds: read.order,
        parks: ordered,
        travelMeters: read.travelMeters,
        travelSeconds: read.travelSeconds,
      };
      state.usage = applyAdd(state.usage, { routeStops: parks.length });
      state.forceOptimize = false;
      await save();
      render();
      return;
    } catch (err) {
      toast(`Google optimize failed (${err.message}). Using the on-phone optimizer.`);
    }
  }
  state.route = localRoute(parks, start, end);
  state.forceOptimize = false;
  await save();
  render();
}

function mark(stop, kind) {
  stop.disposition = kind;
  stop.disposedAt = Date.now();
  stop.knocked = true;
  stop.revisitAt = kind === 'come_back' ? suggestRevisit(Date.now()) : null;
  state.knocks.push({ t: stop.disposedAt });
}

function convexHull(points) {
  const pts = points.slice().sort((a, b) => a.lng - b.lng || a.lat - b.lat);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function render() {
  const demo = demoMode();
  $('demo-banner').hidden = !demo;
  $('start-label').textContent = startLabel();
  $('end-label').textContent = endLabel();
  $('btn-sample').hidden = state.stops.length > 0;
  const stops = dayStops();
  const stats = routeStats(state.route, stops);
  const lines = statsLine(stats, state.settings.departureTime || '10:00', !state.route || state.route.engine !== 'google');
  $('stats-1').textContent = state.stops.length ? lines.line1 : 'No doors yet';
  $('stats-2').textContent = state.stops.length ? lines.line2 : 'Import a list or load the fictional sample';
  $('stats-3').textContent = lines.line3;
  const flagged = blockers(stops);
  $('btn-optimize').disabled = false;
  $('btn-optimize').textContent = state.forceOptimize ? 'Optimize anyway' : 'Optimize';
  const warnings = standingWarnings(state.usage);
  if (flagged.length) warnings.unshift(`${flagged.length} pin${flagged.length === 1 ? '' : 's'} need a rooftop fix.`);
  $('warn').textContent = warnings.join(' ');
  document.querySelectorAll('.tabs button').forEach((btn) => {
    btn.setAttribute('aria-selected', btn.dataset.tab === state.tab ? 'true' : 'false');
  });
  $('panel-stops').hidden = state.tab !== 'stops';
  $('panel-import').hidden = state.tab !== 'import';
  $('panel-day').hidden = state.tab !== 'day';
  $('panel-settings').hidden = state.tab !== 'settings';
  if (state.tab === 'stops') renderStops(stops);
  if (state.tab === 'day') renderDay(stats);
  renderUsage();
  renderRevisits();
  renderSunChrome();
  renderNav();
  renderPin();
  pushMap();
  document.body.dataset.ready = '1';
  document.body.dataset.saving = '0';
}

function renderStops(stops) {
  const root = $('panel-stops');
  if (!stops.length) {
    root.innerHTML = '<p class="muted">No doors on this day.</p>';
    return;
  }
  const order = state.route ? flattenedStops(state.route.parks) : stops.map((s) => s.id);
  const rank = new Map(order.map((id, i) => [id, i]));
  const sorted = stops.slice().sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
  root.innerHTML = sorted.map((stop) => {
    const kind = stop.disposition;
    const flag = stop.status === 'flag';
    const when = stop.revisitAt ? new Date(stop.revisitAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    return `<article class="stop${flag ? ' flagged' : ''}" data-id="${esc(stop.id)}">
      <h3>${esc(stop.address || 'Pin')}</h3>
      <p class="meta">${flag ? esc(stop.flagReason || 'needs a fix') : esc(stop.locationType || 'pin')}${when ? ` · come back ${esc(when)}` : ''}${stop.locked ? ' · locked' : ''}${stop.skipped ? ' · skipped' : ''}</p>
      <div class="row-actions">
        <button type="button" data-act="disp" data-kind="not_home" data-id="${esc(stop.id)}" aria-pressed="${kind === 'not_home'}">Not home</button>
        <button type="button" data-act="disp" data-kind="sit" data-id="${esc(stop.id)}" aria-pressed="${kind === 'sit'}">Sit</button>
        <button type="button" data-act="disp" data-kind="come_back" data-id="${esc(stop.id)}" aria-pressed="${kind === 'come_back'}">Come back</button>
        <button type="button" data-act="disp" data-kind="not_interested" data-id="${esc(stop.id)}" aria-pressed="${kind === 'not_interested'}">No</button>
        <button type="button" data-act="skip" data-id="${esc(stop.id)}">${stop.skipped ? 'Unskip' : 'Skip'}</button>
        <button type="button" data-act="lock" data-id="${esc(stop.id)}">${stop.locked ? 'Unlock' : 'Lock'}</button>
        <button type="button" data-act="move" data-where="next" data-id="${esc(stop.id)}">Next</button>
        <button type="button" data-act="move" data-where="last" data-id="${esc(stop.id)}">Last</button>
        ${flag ? `<button type="button" data-act="validate" data-id="${esc(stop.id)}">Validate</button>` : ''}
        <button type="button" data-act="sun-tap" data-id="${esc(stop.id)}">Sun hours</button>
      </div>
    </article>`;
  }).join('');
}

function renderDay(stats) {
  const root = $('panel-day');
  const chips = state.days.map((day, i) => `<button type="button" class="ghost day-chip" data-act="day" data-day="${i}" aria-pressed="${i === state.activeDay}">Day ${i + 1} · ${day.stopIds.length}</button>`).join('');
  const due = dueRevisits(state.stops, Date.now());
  root.innerHTML = `<div>${chips}</div>
    <p><strong>${stats.knocked}</strong> knocked · <strong>${stats.sits}</strong> sits · ${esc(stats.milesLabel)} · ${esc(stats.hoursLabel)}</p>
    <p class="help">Only this day is sent to Google. A bigger list is split into compact areas of about ${state.settings.doorsPerDay} doors.</p>
    <div class="day-actions"><button type="button" class="ghost" data-act="roll">Roll leftovers forward</button></div>
    ${due.length ? `<p class="help">${due.length} come-back${due.length === 1 ? '' : 's'} due.</p>` : ''}`;
}

function renderUsage() {
  const u = state.usage;
  const learned = learnedMinutes(state.knocks, Date.now());
  const learnedEl = $('learned');
  if (learnedEl) {
    learnedEl.textContent = learned == null
      ? 'Minutes per door is the setting above until a week of knocks can suggest one.'
      : `Last 7 days, median gap ${learned.toFixed(1)} min. Save settings after editing the field to use it.`;
  }
  const el = $('usage');
  if (!el) return;
  el.textContent = `This month: ${u.routeStops || 0} / ${LIMITS.routeStopsFree.toLocaleString('en-US')} stops sent · ${u.geocodes || 0} / ${LIMITS.geocodeFree.toLocaleString('en-US')} geocodes · ${u.buildingInsights || 0} / ${LIMITS.insightsFree.toLocaleString('en-US')} sun lookups · overlay ${u.dataLayersToday || 0} / ${LIMITS.layersPerDay} today, ${u.dataLayers || 0} / ${LIMITS.layersFree.toLocaleString('en-US')} this month.`;
}

function renderRevisits() {
  const due = dueRevisits(state.stops, Date.now());
  const el = $('revisit-banner');
  if (!due.length) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = `Come back due: ${due.map((s) => s.address).slice(0, 2).join(' · ')}`;
}

function renderSunChrome() {
  $('btn-sun').setAttribute('aria-pressed', state.sunOn ? 'true' : 'false');
  const attr = $('solar-attr');
  if (state.sunOn && state.flux?.source === 'google') {
    attr.hidden = false;
    attr.textContent = SOLAR_ATTRIBUTION;
  } else if (state.sunOn && state.flux?.source === 'demo') {
    attr.hidden = false;
    attr.textContent = 'Demo sun preview — not Google solar data.';
  } else {
    attr.hidden = true;
    attr.textContent = '';
  }
  document.querySelectorAll('#layers-pop [data-base]').forEach((btn) => {
    btn.setAttribute('aria-pressed', btn.dataset.base === state.base ? 'true' : 'false');
  });
}

function renderNav() {
  const target = state.route ? nextTarget(state.route, state.stops) : null;
  const nav = $('btn-nav');
  nav.disabled = !target;
  if (!target) {
    $('nav-pop').hidden = true;
    return;
  }
  const links = navLinks(target.park);
  $('nav-google').href = links.google;
  $('nav-waze').href = links.waze;
  $('nav-apple').href = links.apple;
  const tesla = $('btn-tesla');
  const enabled = Boolean(state.health?.tessie);
  tesla.disabled = !enabled;
  tesla.title = enabled ? 'Send this park point to the car' : 'Configure the Worker URL and Tessie secrets';
}

function renderPin() {
  const card = $('pin-card');
  const stop = state.stops.find((s) => s.id === state.selectedId);
  if (!stop) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const insight = stop.insight;
  let sun = '';
  if (insight) {
    const demo = insight.source !== 'google';
    sun = `<p class="help">${demo ? 'Demo preview, not Google data. ' : ''}${insight.sunHours ?? '—'} sun hours/yr · ${insight.maxPanels ?? '—'} panels${insight.best?.azimuth != null ? ` · best face ${Math.round(insight.best.azimuth)}°` : ''}${insight.quality ? ` · ${esc(insight.quality)}` : ''}${insight.date ? ` · ${esc(insight.date)}` : ''}</p>`;
    if (!demo) sun += `<p class="help">${esc(SOLAR_ATTRIBUTION)}</p>`;
  }
  card.innerHTML = `<h3>${esc(stop.address || 'Pin')}</h3>${sun}<div class="row-actions">
    <button type="button" data-act="disp" data-kind="not_home" data-id="${esc(stop.id)}">Not home</button>
    <button type="button" data-act="disp" data-kind="sit" data-id="${esc(stop.id)}">Sit</button>
    <button type="button" data-act="disp" data-kind="come_back" data-id="${esc(stop.id)}">Come back</button>
    <button type="button" data-act="disp" data-kind="not_interested" data-id="${esc(stop.id)}">No</button>
    <button type="button" data-act="sun-tap" data-id="${esc(stop.id)}">Sun hours</button>
    <button type="button" data-act="close-pin">Close</button>
  </div>`;
}

function pushMap() {
  const stops = dayStops().filter((s) => s.lat != null);
  const parks = (state.route?.parks || []).map((p) => ({ id: p.id, lat: p.park.lat, lng: p.park.lng }));
  const drive = [];
  const start = currentStart();
  if (start && parks.length) drive.push(start);
  for (const park of parks) drive.push(park);
  const end = currentEnd();
  if (end && parks.length) drive.push(end);
  const walks = (state.route?.parks || []).map((p) => (p.stops || []).filter((s) => s.lat != null).map((s) => ({ lat: s.lat, lng: s.lng }))).filter((w) => w.length > 1);
  const areas = state.days.map((day) => ({
    points: convexHull(day.stopIds.map((id) => state.stops.find((s) => s.id === id)).filter((s) => s && s.lat != null)),
  }));
  const payload = {
    stops,
    parks,
    drive,
    walks,
    areas,
    showAreas: state.showAreas,
    mode: state.base,
    me: state.me || (state.sample ? demoStart() : null),
    selectedId: state.selectedId,
    flux: state.sunOn ? state.flux : null,
    streetZoom: isStreetZoom(map.metersPerPixel()),
  };
  map.setData(payload);
  if (googleMap) googleMap.setData(payload);
}

async function loadFlux() {
  if (!state.sunOn) return;
  if (!isStreetZoom(map.metersPerPixel())) {
    toast('Zoom in to street level to load the sun overlay.');
    state.flux = null;
    render();
    return;
  }
  const center = map.center;
  if (!workerReady()) {
    const span = map.metersPerPixel() * 180;
    const north = center.lat + span / 111320;
    const south = center.lat - span / 111320;
    const east = center.lng + span / (111320 * Math.cos(center.lat * Math.PI / 180));
    const west = center.lng - span / (111320 * Math.cos(center.lat * Math.PI / 180));
    const grid = demoFlux({ north, south, east, west });
    const painted = fluxToRgba(grid.values, grid.width, grid.height);
    state.flux = { ...grid, rgba: painted.rgba, source: 'demo' };
    render();
    return;
  }
  const key = `solar:${overlayKey(center.lat, center.lng)}`;
  const cached = await kvGet(state.db, key);
  if (cached && cacheFresh(cached.savedAt, Date.now())) {
    const values = Float64Array.from(cached.values);
    const painted = fluxToRgba(values, cached.width, cached.height);
    state.flux = { ...cached, rgba: painted.rgba, source: 'google' };
    render();
    return;
  }
  const gate = assessUsage(state.usage, { dataLayers: 1 });
  if (gate.blocks.length) {
    toast(gate.blocks[0].message);
    return;
  }
  if (gate.warnings.some((w) => w.level === 'over')) toast(gate.warnings[0].message);
  try {
    const data = await layersRemote(state.settings, center.lat, center.lng);
    const binary = Uint8Array.from(atob(data.annualFluxBase64), (c) => c.charCodeAt(0));
    const raster = await decodeGeotiff(binary.buffer);
    const painted = fluxToRgba(raster.values, raster.width, raster.height);
    state.flux = { ...raster, rgba: painted.rgba, source: 'google' };
    state.usage = applyAdd(state.usage, { dataLayers: 1 });
    await kvSet(state.db, key, {
      savedAt: Date.now(),
      width: raster.width,
      height: raster.height,
      north: raster.north,
      south: raster.south,
      east: raster.east,
      west: raster.west,
      values: Array.from(raster.values),
    });
    await save();
    render();
  } catch (err) {
    toast(err.message);
  }
}

async function sunTap(stop) {
  if (!stop) return;
  state.selectedId = stop.id;
  if (stop.insight && cacheFresh(stop.insight.savedAt, Date.now())) {
    render();
    return;
  }
  if (!workerReady() || stop.lat == null) {
    const n = [...stop.id].reduce((h, c) => (h * 33 + c.charCodeAt(0)) >>> 0, 7);
    stop.insight = {
      source: 'demo',
      savedAt: Date.now(),
      sunHours: 1200 + (n % 500),
      maxPanels: 8 + (n % 16),
      quality: 'DEMO',
      date: null,
      best: { pitch: 22, azimuth: 180, area: 36, score: 1 },
    };
    await save();
    render();
    return;
  }
  const gate = assessUsage(state.usage, { buildingInsights: 1 });
  if (gate.warnings.some((w) => w.level === 'over')) toast(gate.warnings[0].message);
  try {
    const raw = await insightsRemote(state.settings, stop.lat, stop.lng);
    const summary = summarizeInsight(raw);
    stop.insight = summary ? { ...summary, source: 'google', savedAt: Date.now() } : { source: 'google', savedAt: Date.now(), sunHours: null, maxPanels: null, quality: 'NONE', date: null, best: null };
    state.usage = applyAdd(state.usage, { buildingInsights: 1 });
    await save();
    render();
  } catch (err) {
    toast(err.message || 'No roof data for this house.');
  }
}

async function locate() {
  if (!navigator.geolocation) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 15000 },
    );
  });
}

function readSettingsForm() {
  state.settings = {
    ...state.settings,
    mapsKey: $('set-key').value.trim(),
    workerUrl: $('set-worker').value.trim(),
    passcode: $('set-pass').value,
    minutesPerDoor: Math.max(0.5, Number($('set-minutes').value) || 3),
    doorsPerDay: Math.max(1, Math.round(Number($('set-per-day').value) || 150)),
    walkMeters: Math.max(40, Number($('set-walk').value) || 150),
    departureTime: $('set-depart').value || '10:00',
    avoidUTurns: $('set-uturn').checked,
  };
}

function fillSettingsForm() {
  $('set-key').value = state.settings.mapsKey || '';
  $('set-worker').value = state.settings.workerUrl || '';
  $('set-pass').value = state.settings.passcode || '';
  $('set-minutes').value = state.settings.minutesPerDoor;
  $('set-per-day').value = state.settings.doorsPerDay;
  $('set-walk').value = state.settings.walkMeters;
  $('set-depart').value = state.settings.departureTime;
  $('set-uturn').checked = Boolean(state.settings.avoidUTurns);
}

async function refreshHealth() {
  if (!workerReady()) {
    state.health = null;
    return;
  }
  try {
    state.health = await workerHealth(state.settings);
  } catch {
    state.health = null;
  }
}

async function maybeMountGoogle() {
  if (!state.settings.mapsKey || googleMap) return;
  try {
    $('gmap').hidden = false;
    googleMap = await mountGoogleMap($('gmap'), state.settings.mapsKey);
    $('map').hidden = true;
    googleMap.onSelect((stop) => { state.selectedId = stop.id; render(); });
    googleMap.onDragEnd((stop, ll) => finishDrag(stop, ll));
    googleMap.onLongPress((ll) => openPress(ll, window.innerWidth / 2, 160));
    googleMap.on('idle', () => {
      const center = googleMap.map.getCenter();
      if (!center) return;
      map.center = { lat: center.lat(), lng: center.lng() };
      map.mpp = googleMap.metersPerPixel();
    });
    attachAutocomplete($('search-input'), googleMap.maps, onPlace);
    pushMap();
  } catch (err) {
    $('gmap').hidden = true;
    $('map').hidden = false;
    googleMap = null;
    toast(err.message);
  }
}

function onPlace(place) {
  if (state.picking === 'start') {
    state.startMode = 'place';
    state.startPlace = place;
    state.picking = null;
  } else if (state.picking === 'end') {
    state.endMode = 'place';
    state.endPlace = place;
    state.picking = null;
  } else {
    state.pendingPlace = place;
    openPress(place, 24, 120, true);
    return;
  }
  save().then(render);
}

function openPress(ll, x, y, fromSearch) {
  const menu = $('press-menu');
  menu.hidden = false;
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 220)}px`;
  menu.innerHTML = `<button type="button" data-act="press-add">Add a stop here</button>
    <button type="button" data-act="press-start">Set as start</button>
    <button type="button" data-act="press-end">Set as end</button>`;
  menu.dataset.lat = ll.lat;
  menu.dataset.lng = ll.lng;
  menu.dataset.address = fromSearch ? (state.pendingPlace?.address || '') : '';
  menu.dataset.placeId = fromSearch ? (state.pendingPlace?.placeId || '') : '';
}

async function finishDrag(stop, ll) {
  const current = state.stops.find((s) => s.id === stop.id) || stop;
  Object.assign(current, applyManualPin(current, ll.lat, ll.lng, Date.now()));
  await save();
  toast('Pin saved. It will not be sent to Google as a rooftop guess.');
  render();
}

function showSearchResults(query) {
  const list = $('search-results');
  const q = query.trim().toLowerCase();
  if (!q || googleMap) {
    list.hidden = true;
    return;
  }
  const hits = state.stops.filter((s) => (s.address || '').toLowerCase().includes(q)).slice(0, 6);
  const coord = q.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  list.innerHTML = hits.map((s) => `<li><button type="button" data-act="jump" data-id="${esc(s.id)}">${esc(s.address)}</button></li>`).join('');
  if (coord) list.innerHTML += `<li><button type="button" data-act="jump-coord" data-lat="${esc(coord[1])}" data-lng="${esc(coord[2])}">Go to ${esc(q)}</button></li>`;
  else list.innerHTML += `<li><button type="button" data-act="add-query">Add “${esc(query.trim())}”</button></li>`;
  list.hidden = false;
}

async function onClick(event) {
  const btn = event.target.closest('[data-act]');
  if (!btn) {
    if (!event.target.closest('#layers-pop') && !event.target.closest('#btn-layers')) $('layers-pop').hidden = true;
    if (!event.target.closest('#nav-pop') && !event.target.closest('#btn-nav')) $('nav-pop').hidden = true;
    if (!event.target.closest('#press-menu')) $('press-menu').hidden = true;
    return;
  }
  const act = btn.dataset.act;
  const stop = () => state.stops.find((s) => s.id === btn.dataset.id);
  if (act === 'tab') {
    state.tab = btn.dataset.tab;
    if (state.snap === 'peek') setSnap('half');
    render();
    return;
  }
  if (act === 'sample') {
    document.body.dataset.saving = '1';
    await addStops(demoStops(), { sample: true });
    return;
  }
  if (act === 'optimize') {
    document.body.dataset.saving = '1';
    await onOptimize();
    return;
  }
  if (act === 'reopt') {
    const pos = await locate();
    if (pos) state.me = pos;
    else if (!state.me && (state.sample || demoMode())) state.me = demoStart();
    state.startMode = 'me';
    toast(pos ? 'Re-optimizing from your location. Knocked doors stay put.' : 'No GPS fix. Using the last location.');
    document.body.dataset.saving = '1';
    await onOptimize();
    return;
  }
  if (act === 'sun') {
    state.sunOn = !state.sunOn;
    if (!state.sunOn) state.flux = null;
    render();
    if (state.sunOn) await loadFlux();
    return;
  }
  if (act === 'layers') {
    const pop = $('layers-pop');
    pop.hidden = !pop.hidden;
    return;
  }
  if (act === 'base') {
    state.base = btn.dataset.base;
    $('layers-pop').hidden = true;
    render();
    return;
  }
  if (act === 'me') {
    const pos = await locate();
    if (pos) state.me = pos;
    else state.me = state.me || (demoMode() ? demoStart() : null);
    if (!state.me) {
      toast('Location is unavailable.');
      return;
    }
    map.center = { ...state.me };
    map.mpp = 1.6;
    map.draw();
    render();
    return;
  }
  if (act === 'nav') {
    $('nav-pop').hidden = !$('nav-pop').hidden;
    return;
  }
  if (act === 'tesla') {
    const target = nextTarget(state.route, state.stops);
    if (!target || !state.health?.tessie) return;
    try {
      await teslaRemote(state.settings, target.park.lat, target.park.lng, target.stopIds?.[0] || '');
      toast('Sent to Tesla.');
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  if (act === 'pick-start') {
    state.picking = 'start';
    $('search-input').focus();
    toast('Search a place, or long-press the map, to set the start.');
    return;
  }
  if (act === 'pick-end') {
    if (state.endMode === 'place') {
      state.endMode = 'start';
      state.endPlace = null;
      await save();
      render();
      return;
    }
    state.picking = 'end';
    $('search-input').focus();
    toast('Search a place for the end, or tap End again for same as start.');
    return;
  }
  if (act === 'disp') {
    const row = stop();
    if (!row) return;
    document.body.dataset.saving = '1';
    mark(row, btn.dataset.kind);
    await save();
    render();
    return;
  }
  if (act === 'skip') {
    const row = stop();
    if (!row) return;
    row.skipped = !row.skipped;
    state.route = null;
    await save();
    render();
    return;
  }
  if (act === 'lock') {
    const row = stop();
    if (!row) return;
    row.locked = !row.locked;
    await save();
    toast(row.locked ? 'Locked. It keeps its place the next time you optimize.' : 'Unlocked.');
    render();
    return;
  }
  if (act === 'move') {
    const ids = state.route ? flattenedStops(state.route.parks) : dayStops().map((s) => s.id);
    const next = moveVisit(ids, btn.dataset.id, btn.dataset.where);
    const byId = new Map(state.stops.map((s) => [s.id, s]));
    const parks = next.map((id) => {
      const s = byId.get(id);
      return s && s.lat != null ? {
        id: `m-${id}`,
        stopIds: [id],
        stops: [s],
        park: { lat: s.lat, lng: s.lng },
        serviceSeconds: (Number(state.settings.minutesPerDoor) || 3) * 60,
        doorCount: 1,
        sideOfRoad: false,
        heading: null,
      } : null;
    }).filter(Boolean);
    const start = currentStart() || parks[0]?.park;
    const end = currentEnd() || start;
    if (start) state.route = { ...localRoute(parks, start, end), engine: 'manual' };
    await save();
    render();
    return;
  }
  if (act === 'validate') {
    const row = stop();
    if (!row) return;
    if (!workerReady()) {
      toast('Address Validation needs the Worker.');
      return;
    }
    try {
      const body = await validateRemote(state.settings, row.address);
      Object.assign(row, applyGeocode(row, classifyValidation(body), Date.now(), 'validation'));
      await save();
      toast(row.status === 'accept' ? 'Premise match. Pin accepted.' : 'Still not a building. Drag the pin on satellite.');
      if (row.status !== 'accept') state.base = 'satellite';
      render();
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  if (act === 'sun-tap') {
    await sunTap(stop());
    return;
  }
  if (act === 'close-pin') {
    state.selectedId = null;
    render();
    return;
  }
  if (act === 'jump') {
    state.selectedId = btn.dataset.id;
    const row = stop();
    if (row?.lat != null) {
      map.center = { lat: row.lat, lng: row.lng };
      map.mpp = 1.2;
    }
    $('search-results').hidden = true;
    render();
    return;
  }
  if (act === 'jump-coord') {
    map.center = { lat: Number(btn.dataset.lat), lng: Number(btn.dataset.lng) };
    map.mpp = 1.4;
    map.draw();
    $('search-results').hidden = true;
    return;
  }
  if (act === 'add-query') {
    const text = $('search-input').value.trim();
    if (!text) return;
    await addStops(parsePaste(text));
    $('search-results').hidden = true;
    return;
  }
  if (act === 'import-paste') {
    await addStops(parsePaste($('paste').value));
    return;
  }
  if (act === 'import-sheet') {
    let csvUrl;
    try {
      csvUrl = toSheetCsvUrl($('sheet-url').value);
    } catch (err) {
      toast(err.message);
      return;
    }
    try {
      let csv;
      if (workerReady()) csv = (await sheetRemote(state.settings, csvUrl)).csv;
      else csv = await (await fetch(csvUrl)).text();
      await addStops(parsePaste(csv));
    } catch (err) {
      toast(err.message || 'Could not read that sheet. Paste the CSV instead.');
    }
    return;
  }
  if (act === 'day') {
    state.activeDay = Number(btn.dataset.day) || 0;
    state.route = null;
    render();
    const points = dayStops().filter((s) => s.lat != null);
    if (points.length) map.fit(points, { top: 130, bottom: 340, left: 28, right: 72 });
    return;
  }
  if (act === 'roll') {
    const done = new Set(state.stops.filter((s) => s.disposition || s.skipped).map((s) => s.id));
    const byId = new Map(state.stops.map((s) => [s.id, s]));
    state.days = rollForward(state.days, done, state.settings.doorsPerDay, byId);
    assignDays();
    state.route = null;
    await save();
    toast('Unknocked doors were split into the next areas.');
    render();
    return;
  }
  if (act === 'save-settings') {
    const previousKey = state.settings.mapsKey;
    readSettingsForm();
    assignDays();
    await save();
    await refreshHealth();
    if (state.settings.mapsKey && state.settings.mapsKey !== previousKey) await maybeMountGoogle();
    toast(state.health?.tessie ? 'Saved. Send to Tesla is on.' : 'Saved.');
    render();
    return;
  }
  if (act === 'export') {
    const blob = new Blob([JSON.stringify({
      stops: state.stops,
      days: state.days,
      route: state.route,
      knocks: state.knocks,
    }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'blockwalk-backup.json';
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }
  if (act === 'clear') {
    if (!confirm('Erase routes and stops stored on this phone?')) return;
    state.stops = [];
    state.days = [];
    state.route = null;
    state.sample = false;
    state.knocks = [];
    await save();
    render();
    return;
  }
  if (act === 'press-add' || act === 'press-start' || act === 'press-end') {
    const menu = $('press-menu');
    const lat = Number(menu.dataset.lat);
    const lng = Number(menu.dataset.lng);
    const address = menu.dataset.address || '';
    const placeId = menu.dataset.placeId || null;
    menu.hidden = true;
    if (act === 'press-start') {
      state.startMode = 'place';
      state.startPlace = { lat, lng, address: address || 'Map point' };
    } else if (act === 'press-end') {
      state.endMode = 'place';
      state.endPlace = { lat, lng, address: address || 'Map point' };
    } else if (address) {
      await addStops([{ address, lat, lng, placeId, status: 'accept', flagReason: '', locationType: 'ROOFTOP', coordSource: 'google', geocodedAt: Date.now() }]);
      return;
    } else {
      await addStops([applyManualPin({ address: 'Dropped pin', status: 'flag', flagReason: 'needs_geocode' }, lat, lng, Date.now())]);
      return;
    }
    await save();
    render();
  }
}

function bind() {
  document.body.addEventListener('click', (event) => {
    onClick(event).catch((err) => toast(err.message || 'Something went wrong.'));
  });
  $('search').addEventListener('submit', (event) => event.preventDefault());
  $('search-input').addEventListener('input', () => showSearchResults($('search-input').value));
  $('areas-toggle').addEventListener('change', () => {
    state.showAreas = $('areas-toggle').checked;
    render();
  });
  $('csv-file').addEventListener('change', async () => {
    const file = $('csv-file').files?.[0];
    if (!file) return;
    await addStops(parsePaste(await file.text()));
    $('csv-file').value = '';
  });
  $('backup-file').addEventListener('change', async () => {
    const file = $('backup-file').files?.[0];
    if (!file) return;
    const data = JSON.parse(await file.text());
    state.stops = (data.stops || []).map((s) => refreshStaleStop(s, Date.now()));
    state.days = data.days || [];
    state.route = data.route || null;
    state.knocks = data.knocks || [];
    state.sample = state.stops.every((s) => s.coordSource === 'sample');
    assignDays();
    await save();
    render();
    $('backup-file').value = '';
  });
  const handle = $('handle');
  let startY = 0;
  let startH = 0;
  handle.addEventListener('pointerdown', (event) => {
    startY = event.clientY;
    startH = $('sheet').getBoundingClientRect().height;
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    const h = Math.min(window.innerHeight - 20, Math.max(220, startH + (startY - event.clientY)));
    document.documentElement.style.setProperty('--sheet-h', `${h}px`);
  });
  handle.addEventListener('pointerup', () => {
    const h = $('sheet').getBoundingClientRect().height;
    setSnap(h > window.innerHeight * 0.75 ? 'full' : h > 420 ? 'half' : 'peek');
  });
  map.onSelect = (stop) => {
    state.selectedId = stop.id;
    if (stop.status === 'flag') state.base = 'satellite';
    render();
  };
  map.onLongPress = (ll, x, y) => openPress(ll, x, y, false);
  map.onDragEnd = (stop, ll) => finishDrag(stop, ll);
  map.onView = () => {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
      if (state.sunOn) loadFlux();
    }, 450);
  };
}

async function registerSw() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const scope = new URL('./', window.location.href);
    await navigator.serviceWorker.register(new URL('sw.js', scope).href, { scope: scope.pathname });
  } catch {
    /* http pages outside a secure context, or a mismatched scope, still run online. */
  }
}

async function boot() {
  setSnap('peek');
  map = new CanvasMap($('map'));
  bind();
  registerSw();
  try {
    state.db = await openDb();
    hydrate(await kvGet(state.db, 'state'));
    const now = Date.now();
    const keys = await new Promise((resolve) => {
      const names = [];
      const tx = state.db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(names);
        if (String(cursor.key).startsWith('solar:')) names.push([cursor.key, cursor.value]);
        cursor.continue();
      };
      req.onerror = () => resolve(names);
    });
    for (const [key, value] of keys) {
      if (!value || !cacheFresh(value.savedAt, now) || now - value.savedAt > SOLAR_MAX_AGE_MS) {
        const tx = state.db.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete(key);
      }
    }
  } catch {
    toast('This browser will not keep the route after a refresh.');
  }
  fillSettingsForm();
  render();
  await refreshHealth();
  await maybeMountGoogle();
  const pos = await locate();
  if (pos) {
    state.me = pos;
    render();
  }
  if (state.stops.length) {
    const points = dayStops().filter((s) => s.lat != null);
    if (points.length) map.fit(points, { top: 130, bottom: 340, left: 28, right: 72 });
  }
}

boot();
