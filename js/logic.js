/* Pure logic: dispositions, statuses, normalizing, priority sort, stats, CSV. No DOM, no storage. */
(function () {
  'use strict';
  var L = {};

  /* ---------- dates ---------- */
  L.startOfDay = function (d) { d = new Date(d); d.setHours(0, 0, 0, 0); return d; };
  L.addDays = function (d, n) { d = new Date(d); d.setDate(d.getDate() + n); return d; };
  L.startOfWeek = function (d) { d = L.startOfDay(d); return L.addDays(d, -((d.getDay() + 6) % 7)); }; // Monday
  L.startOfMonth = function (d) { d = L.startOfDay(d); d.setDate(1); return d; };
  L.range = function (period, offset, now) {
    now = now || new Date(); offset = offset || 0; var from, to;
    if (period === 'day') { from = L.addDays(L.startOfDay(now), offset); to = L.addDays(from, 1); }
    else if (period === 'week') { from = L.addDays(L.startOfWeek(now), offset * 7); to = L.addDays(from, 7); }
    else { from = L.startOfMonth(now); from.setMonth(from.getMonth() + offset); to = new Date(from); to.setMonth(to.getMonth() + 1); }
    return { from: from, to: to };
  };
  L.toLocalInput = function (d) {
    d = new Date(d); var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  L.fromLocalInput = function (s) { if (!s) return null; var d = new Date(s); return isNaN(d) ? null : d.toISOString(); };

  /* ---------- dispositions & statuses ---------- */
  // conv = counts as a real conversation. status = lead status it sets.
  L.DISP = {
    not_home:       { label: 'Not home',       tone: 'mute',  status: 'contacted', keepNext: true },
    no_answer:      { label: 'No answer',      tone: 'mute',  status: 'contacted', keepNext: true },
    voicemail:      { label: 'Voicemail',      tone: 'mute',  status: 'contacted', keepNext: true },
    talked:         { label: 'Talked',         tone: 'blue',  status: 'contacted', conv: true },
    interested:     { label: 'Interested',     tone: 'green', status: 'interested', conv: true },
    callback:       { label: 'Callback',       tone: 'amber', status: 'callback', conv: true, needsTime: 'Callback time' },
    sit_booked:     { label: 'Sit booked',     tone: 'green', status: 'sit', conv: true, needsTime: 'Sit time' },
    not_interested: { label: 'Not interested', tone: 'red',   status: 'not_interested', conv: true },
    wrong_number:   { label: 'Wrong number',   tone: 'red',   status: 'wrong_number' },
    dnk:            { label: 'Do not knock',   callLabel: 'Do not call', tone: 'dark', status: 'dnk', conv: true }
  };
  L.DOOR_DISPS = ['not_home', 'talked', 'interested', 'callback', 'sit_booked', 'not_interested', 'dnk'];
  L.CALL_DISPS = ['no_answer', 'voicemail', 'talked', 'interested', 'callback', 'sit_booked', 'not_interested', 'wrong_number', 'dnk'];
  L.dispLabel = function (key, type) { var d = L.DISP[key]; if (!d) return key; return (type === 'call' && d.callLabel) || d.label; };

  L.STATUS = {
    new: 'New', contacted: 'Contacted', interested: 'Interested', callback: 'Callback', sit: 'Sit booked',
    sat: 'Sat', closed: 'Closed', no_show: 'No-show', not_interested: 'Not interested',
    wrong_number: 'Wrong number', dnk: 'Do not knock/call'
  };
  L.TERMINAL = ['closed', 'not_interested', 'wrong_number', 'dnk'];
  L.isTerminal = function (s) { return L.TERMINAL.indexOf(s) >= 0; };

  // status after logging a disposition on a lead
  L.nextStatus = function (cur, disp) {
    var d = L.DISP[disp]; if (!d) return cur;
    if (disp === 'dnk') return 'dnk';
    if (cur === 'closed') return cur;
    if (d.status === 'contacted') return (cur === 'new' || !cur) ? 'contacted' : cur;
    return d.status;
  };

  /* ---------- normalizing & suppression ---------- */
  var ABBR = { street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', lane: 'ln', court: 'ct', circle: 'cir', boulevard: 'blvd', place: 'pl', terrace: 'ter', parkway: 'pkwy', highway: 'hwy', apartment: 'apt', north: 'n', south: 's', east: 'e', west: 'w' };
  L.normAddr = function (a) {
    if (!a) return '';
    a = String(a).toLowerCase().split(',')[0];
    a = a.replace(/[.#]/g, ' ').replace(/[^a-z0-9 ]/g, ' ');
    return a.split(/\s+/).filter(Boolean).map(function (w) { return ABBR[w] || w; }).join(' ');
  };
  L.normPhone = function (p) { var d = String(p || '').replace(/\D/g, ''); if (d.length < 7) return ''; return d.slice(-10); };
  L.formatPhone = function (p) {
    var d = String(p || '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length === 10) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
    return p || '';
  };
  L.looksLikePhone = function (q) { var d = String(q || '').replace(/\D/g, ''); return d.length >= 7 && /^[\d\s()+.\-]+$/.test(q); };

  L.suppressionIndex = function (entries) {
    var idx = { phones: new Set(), addrs: new Set() };
    entries.forEach(function (s) {
      var p = L.normPhone(s.phone), a = L.normAddr(s.address);
      if (p) idx.phones.add(p); if (a) idx.addrs.add(a);
    });
    return idx;
  };
  L.isSuppressed = function (lead, idx) {
    if (lead.status === 'dnk') return true;
    var p = L.normPhone(lead.phone), a = L.normAddr(lead.address);
    return !!((p && idx.phones.has(p)) || (a && idx.addrs.has(a)));
  };

  /* ---------- priority ---------- */
  L.isDue = function (lead, now) {
    if (!lead.next_action_at || L.isTerminal(lead.status)) return false;
    return Date.parse(lead.next_action_at) <= +L.addDays(L.startOfDay(now || new Date()), 1) - 1;
  };
  L.tier = function (lead, now) {
    if (L.isDue(lead, now)) return 0;
    if (lead.status === 'new') return 1;
    if (L.isTerminal(lead.status)) return 3;
    return 2;
  };
  L.prioritySort = function (leads, now) {
    now = now || new Date();
    var arr = leads.map(function (l) { return { l: l, t: L.tier(l, now) }; });
    arr.sort(function (A, B) {
      if (A.t !== B.t) return A.t - B.t;
      var a = A.l, b = B.l;
      if (A.t === 0) return Date.parse(a.next_action_at) - Date.parse(b.next_action_at);
      if (A.t === 1) return Date.parse(b.created_at) - Date.parse(a.created_at); // newest first
      var ta = a.last_touch_at ? Date.parse(a.last_touch_at) : 0, tb = b.last_touch_at ? Date.parse(b.last_touch_at) : 0;
      return ta - tb; // oldest touch first
    });
    return arr.map(function (x) { return x.l; });
  };

  /* ---------- stats ---------- */
  L.computeStats = function (touches, appts, from, to) {
    var f = +from, t = +to;
    var s = { doors: 0, calls: 0, conversations: 0, sits: 0, sat: 0, closes: 0, noshow: 0, byDisp: {} };
    touches.forEach(function (x) {
      var ts = Date.parse(x.created_at); if (!(ts >= f && ts < t)) return;
      if (x.type === 'call') s.calls++; else s.doors++;
      var d = L.DISP[x.disposition];
      if (d && d.conv) s.conversations++;
      var k = x.type + ':' + x.disposition; s.byDisp[k] = (s.byDisp[k] || 0) + 1;
    });
    appts.forEach(function (a) {
      var cs = Date.parse(a.created_at);
      if (cs >= f && cs < t) s.sits++;
      if (a.result) {
        var rs = Date.parse(a.result_at || a.starts_at);
        if (rs >= f && rs < t) {
          if (a.result === 'sat' || a.result === 'closed') s.sat++;
          if (a.result === 'closed') s.closes++;
          if (a.result === 'no_show') s.noshow++;
        }
      }
    });
    s.touches = s.doors + s.calls;
    return s;
  };
  L.rate = function (n, d) { return d > 0 ? Math.round(n * 1000 / d) / 10 : null; };

  /* ---------- CSV ---------- */
  var CSV = {};
  CSV.parse = function (text) {
    text = String(text).replace(/^\uFEFF/, '');
    var first = text.split(/\r?\n/)[0] || '';
    var delim = [',', '\t', ';'].map(function (d) { return [d, first.split(d).length]; }).sort(function (a, b) { return b[1] - a[1]; })[0][0];
    var rows = [], row = [], f = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(f); f = ''; rows.push(row); row = [];
      } else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return String(x).trim() !== ''; }); });
  };
  CSV.stringify = function (rows) {
    return rows.map(function (r) {
      return r.map(function (v) {
        v = v == null ? '' : String(v);
        if (/^[=@]/.test(v)) v = "'" + v;
        return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    }).join('\r\n');
  };
  var GUESS = [
    ['email', /e-?mail/i], ['phone', /phone|mobile|cell|tel\b/i], ['last_name', /last\s*name|surname/i],
    ['zip', /zip|postal/i], ['city', /^city|town/i], ['utility', /utility|electric/i],
    ['roof_notes', /roof|notes?$|comment/i], ['source', /source|campaign|origin/i],
    ['address', /address|street|addr\b|location/i], ['name', /^(full\s*)?name|owner|homeowner|customer|contact|first\s*name/i]
  ];
  CSV.guessMap = function (headers) {
    var map = {}, used = {};
    GUESS.forEach(function (g) {
      for (var i = 0; i < headers.length; i++) {
        if (!used[i] && g[1].test(headers[i])) { map[g[0]] = i; used[i] = 1; return; }
      }
    });
    return map;
  };
  CSV.rowToLead = function (row, map) {
    var get = function (k) { return map[k] === undefined || map[k] === '' ? '' : String(row[map[k]] || '').trim(); };
    var name = (get('name') + ' ' + get('last_name')).trim();
    var addr = get('address'), city = get('city'), zip = get('zip');
    if (addr && city) addr += ', ' + city; if (addr && zip) addr += ' ' + zip;
    return { name: name, address: addr, phone: get('phone'), email: get('email'), utility: get('utility'), roof_notes: get('roof_notes'), source: get('source') };
  };

  window.Logic = L; window.CSV = CSV;
})();
