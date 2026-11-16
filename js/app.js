/* UI layer. Talks to window.DB (storage) and window.Logic / window.CSV (pure logic). */
(function () {
  'use strict';
  var L = Logic;
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var ui = { filter: 'all', q: '', limit: 60, statsPeriod: 'day', statsOffset: 0 };
  var imp = null; // import wizard state
  var LG = null;  // log sheet state

  /* ---------- helpers ---------- */
  function now() { return new Date(); }
  function fmtTime(d) { return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function fmtWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso), diff = Math.round((L.startOfDay(d) - L.startOfDay(now())) / 864e5), t = fmtTime(d);
    if (diff === 0) return 'Today ' + t; if (diff === 1) return 'Tomorrow ' + t; if (diff === -1) return 'Yesterday ' + t;
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + t;
  }
  function ago(iso) {
    if (!iso) return 'never';
    var m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + 'm ago'; if (m < 1440) return Math.round(m / 60) + 'h ago';
    var d = Math.round(m / 1440); return d < 60 ? d + 'd ago' : Math.round(d / 30) + 'mo ago';
  }
  function title(l) { return l.name || l.address || L.formatPhone(l.phone) || 'Unnamed lead'; }
  function sub(l) {
    var p = []; if (l.name && l.address) p.push(l.address); if (l.phone) p.push(L.formatPhone(l.phone));
    return p.join(' · ') || (l.name ? '' : '');
  }
  function mapsUrl(addr) { return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(addr); }
  function telUrl(p) { var d = String(p).replace(/[^\d+]/g, ''); return 'tel:' + d; }
  function chip(status) { return '<span class="chip s-' + esc(status) + '">' + esc(L.STATUS[status] || status) + '</span>'; }
  function toast(msg, err) {
    var t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = ''; }, 2200);
  }
  function download(name, text, mime) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function suppIdx() { return L.suppressionIndex(DB.list('suppression')); }
  function visibleLeads() { var idx = suppIdx(); return DB.list('leads').filter(function (l) { return !L.isSuppressed(l, idx); }); }
  function leadTouches(id) { return DB.list('touches').filter(function (t) { return t.lead_id === id; }).sort(function (a, b) { return Date.parse(b.created_at) - Date.parse(a.created_at); }); }
  function leadAppts(id) { return DB.list('appointments').filter(function (a) { return a.lead_id === id; }).sort(function (a, b) { return Date.parse(b.starts_at) - Date.parse(a.starts_at); }); }
  function leadRow(l, extra) {
    var due = L.isDue(l, now()), late = due && Date.parse(l.next_action_at) < +L.startOfDay(now());
    return '<div class="card row" data-act="open" data-id="' + l.id + '"><div class="grow"><div class="t">' + esc(title(l)) + '</div><div class="s">' + esc(sub(l)) + '</div>' +
      (l.next_action_at && !L.isTerminal(l.status) ? '<div class="s">⏰ ' + esc(fmtWhen(l.next_action_at)) + '</div>' : '') + '</div>' +
      (due ? '<span class="chip ' + (late ? 'late' : 'due') + '">' + (late ? 'Overdue' : 'Due') + '</span>' : '') + chip(l.status) + (extra || '') + '</div>';
  }

  /* ---------- views ---------- */
  var views = {};

  views.today = function () {
    var cfg = DB.settings(), r = L.range('day', 0), s = L.computeStats(DB.list('touches'), DB.list('appointments'), r.from, r.to);
    var pct = Math.min(100, Math.round(s.doors * 100 / cfg.target));
    var leads = visibleLeads().filter(function (l) { return L.isDue(l, now()); }).sort(function (a, b) { return Date.parse(a.next_action_at) - Date.parse(b.next_action_at); });
    var idx = suppIdx(), ids = {}; DB.list('leads').forEach(function (l) { ids[l.id] = l; });
    var appts = DB.list('appointments').filter(function (a) {
      var l = ids[a.lead_id]; if (!l || L.isSuppressed(l, idx)) return false;
      return !a.result && Date.parse(a.starts_at) < +L.addDays(L.startOfDay(now()), 1);
    }).sort(function (a, b) { return Date.parse(a.starts_at) - Date.parse(b.starts_at); });
    var h = '<button class="bigLog" data-act="log">+ Log a door or call</button>';
    h += '<h2>Callbacks due <span class="count">' + leads.length + '</span></h2>';
    h += leads.length ? leads.map(function (l) {
      var late = Date.parse(l.next_action_at) < +L.startOfDay(now());
      return '<div class="card" data-act="open" data-id="' + l.id + '"><div class="row"><div class="grow"><div class="t">' + esc(title(l)) + '</div><div class="s">' + esc(sub(l)) + '</div></div>' +
        '<span class="chip ' + (late ? 'late' : 'due') + '">' + esc(fmtWhen(l.next_action_at)) + '</span></div>' +
        '<div class="btns" style="margin-bottom:0">' + (l.phone ? '<a class="btn sm" href="' + telUrl(l.phone) + '">📞 Call</a>' : '') +
        (l.address ? '<a class="btn sm" target="_blank" rel="noopener" href="' + mapsUrl(l.address) + '">🧭 Go</a>' : '') +
        '<button class="btn sm primary" data-act="log" data-id="' + l.id + '">Log</button></div></div>';
    }).join('') : '<div class="empty">No callbacks due. Go knock doors.</div>';
    if (appts.length) {
      h += '<h2>Sits today <span class="count">' + appts.length + '</span></h2>' + appts.map(function (a) {
        var l = ids[a.lead_id]; return '<div class="card row" data-act="open" data-id="' + l.id + '"><div class="grow"><div class="t">' + esc(title(l)) + '</div><div class="s">' + esc(l.address || '') + '</div></div><span class="chip due">' + esc(fmtWhen(a.starts_at)) + '</span></div>';
      }).join('');
    }
    h += '<h2>Today</h2><div class="card"><div class="hero"><b id="doors-n">' + s.doors + '</b><span class="muted">/ ' + cfg.target + ' doors</span></div>' +
      '<div class="bar ' + (s.doors >= cfg.target ? 'done' : '') + '"><div style="width:' + pct + '%"></div></div><div class="small muted">' + (s.doors >= cfg.target ? 'Target hit.' : (cfg.target - s.doors) + ' to go') + '</div></div>';
    h += '<div class="grid"><div class="stat"><b>' + s.conversations + '</b><span>Conversations</span></div><div class="stat"><b>' + s.sits + '</b><span>Sits booked</span></div><div class="stat"><b>' + s.closes + '</b><span>Closes</span></div></div>';
    h += '<div class="small muted" style="margin-top:8px">Calls today: ' + s.calls + ' · Sat today: ' + s.sat + '</div>';
    return { title: new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }), html: h };
  };

  var FILTERS = [['all', 'All'], ['due', 'Due'], ['new', 'New'], ['contacted', 'Contacted'], ['interested', 'Interested'], ['callback', 'Callback'], ['sit', 'Sit'], ['sat', 'Sat'], ['closed', 'Closed'], ['no_show', 'No-show'], ['not_interested', 'Not interested'], ['wrong_number', 'Wrong #']];
  function filteredLeads() {
    var q = ui.q.trim().toLowerCase(), qp = L.normPhone(ui.q), qa = L.normAddr(ui.q);
    var arr = visibleLeads().filter(function (l) {
      if (ui.filter === 'due') { if (!L.isDue(l, now())) return false; }
      else if (ui.filter !== 'all' && l.status !== ui.filter) return false;
      if (!q) return true;
      return (l.name || '').toLowerCase().indexOf(q) >= 0 || (l.address || '').toLowerCase().indexOf(q) >= 0 ||
        (qa && L.normAddr(l.address).indexOf(qa) >= 0) || (qp && L.normPhone(l.phone) === qp) ||
        (l.phone || '').replace(/\D/g, '').indexOf(q.replace(/\D/g, '') || '\u0000') >= 0 || (l.email || '').toLowerCase().indexOf(q) >= 0;
    });
    return L.prioritySort(arr, now());
  }
  function leadListHtml() {
    var arr = filteredLeads(), shown = arr.slice(0, ui.limit);
    var h = '<div class="small muted" style="margin:0 2px 8px" id="lead-count">' + arr.length + ' lead' + (arr.length === 1 ? '' : 's') + '</div>';
    h += shown.map(function (l) { return leadRow(l); }).join('');
    if (arr.length > shown.length) h += '<button class="btn block" data-act="more-leads">Show more (' + (arr.length - shown.length) + ' left)</button>';
    if (!arr.length) h += '<div class="empty">' + (DB.list('leads').length ? 'No leads match.' : 'No leads yet. Tap + Log, add one, or import a CSV.') + '</div>';
    return h;
  }
  views.leads = function () {
    var h = '<div class="row" style="gap:8px"><input id="lead-q" type="search" placeholder="Search name, address, phone" value="' + esc(ui.q) + '" autocomplete="off"><a class="btn primary" href="#/lead/new" style="flex:none">+ Add</a></div>';
    h += '<div class="filters" id="filters">' + FILTERS.map(function (f) { return '<button data-act="filter" data-f="' + f[0] + '" class="' + (ui.filter === f[0] ? 'on' : '') + '">' + f[1] + '</button>'; }).join('') + '</div>';
    h += '<div id="leadlist">' + leadListHtml() + '</div>';
    return { title: 'Leads', html: h };
  };

  views.lead = function (id) {
    var isNew = id === 'new', l = isNew ? { status: 'new', source: '' } : DB.get('leads', id);
    if (!l) return { title: 'Lead', html: '<div class="empty">Lead not found. <a href="#/leads" style="color:var(--amber)">Back to leads</a></div>' };
    var h = '<a href="#/leads" class="muted small">‹ Leads</a>';
    if (!isNew) {
      var sup = L.isSuppressed(l, suppIdx());
      h += '<div class="row" style="margin:6px 0 4px"><div class="grow"><div style="font-size:22px;font-weight:750">' + esc(title(l)) + '</div></div>' + chip(l.status) + '</div>';
      if (sup) h += '<div class="warn">On the suppression list — hidden from lists. Restore it under More › Suppression list.</div>';
      h += '<div class="btns">' + (l.phone ? '<a class="btn blue" href="' + telUrl(l.phone) + '">📞 Call</a>' : '') +
        (l.address ? '<a class="btn" target="_blank" rel="noopener" href="' + mapsUrl(l.address) + '">🧭 Navigate</a>' : '') +
        '<button class="btn primary" data-act="log" data-id="' + l.id + '">Log touch</button></div>';
      h += '<h2>Next action</h2><div class="card"><input type="datetime-local" id="lf-next" value="' + (l.next_action_at ? L.toLocalInput(l.next_action_at) : '') + '">' +
        '<div class="btns" style="margin-bottom:0"><button class="btn sm" data-act="save-next" data-id="' + l.id + '">Save time</button><button class="btn sm" data-act="clear-next" data-id="' + l.id + '">Clear</button></div></div>';
    }
    h += '<h2>' + (isNew ? 'New lead' : 'Details') + '</h2><div class="card" id="lead-form">' +
      field('lf-name', 'Name', l.name) + field('lf-address', 'Address', l.address) + field('lf-phone', 'Phone', l.phone, 'tel') + field('lf-email', 'Email', l.email, 'email') +
      field('lf-utility', 'Utility', l.utility) + '<label>Roof notes</label><textarea id="lf-roof">' + esc(l.roof_notes || '') + '</textarea>' +
      field('lf-source', 'Source', l.source) +
      '<label>Status</label><select id="lf-status">' + Object.keys(L.STATUS).map(function (k) { return '<option value="' + k + '"' + (l.status === k ? ' selected' : '') + '>' + esc(L.STATUS[k]) + '</option>'; }).join('') + '</select>' +
      '<div class="btns"><button class="btn primary" data-act="save-lead" data-id="' + (isNew ? 'new' : l.id) + '">Save lead</button></div></div>';
    if (!isNew) {
      var ap = leadAppts(l.id);
      h += '<h2>Appointments <span class="count">' + ap.length + '</span></h2>';
      h += ap.map(function (a) { return apptCard(a, l, true); }).join('');
      h += '<div class="card"><label style="margin-top:0">Book a sit</label><input type="datetime-local" id="lf-sit" value="' + L.toLocalInput(L.addDays(now(), 1).setHours(18, 0, 0, 0)) + '">' +
        '<div class="btns" style="margin-bottom:0"><button class="btn sm" data-act="book-appt" data-id="' + l.id + '">Book sit</button></div></div>';
      var ts = leadTouches(l.id);
      h += '<h2>Timeline <span class="count">' + ts.length + '</span></h2>';
      h += ts.length ? '<div class="tl">' + ts.map(function (t) {
        return '<div class="it ' + esc(t.type) + '"><div><b>' + (t.type === 'call' ? '📞 ' : '🚪 ') + esc(L.dispLabel(t.disposition, t.type)) + '</b></div>' +
          (t.note ? '<div>' + esc(t.note) + '</div>' : '') + (t.next_action_at ? '<div class="small muted">Next: ' + esc(fmtWhen(t.next_action_at)) + '</div>' : '') +
          '<div class="when">' + esc(fmtWhen(t.created_at)) + '</div></div>';
      }).join('') + '</div>' : '<div class="empty">No touches yet.</div>';
      h += '<div class="btns" style="margin-top:20px"><button class="btn danger" data-act="del-lead" data-id="' + l.id + '">Delete lead</button></div>';
    }
    return { title: isNew ? 'New lead' : 'Lead', html: h };
  };
  function field(id, label, val, type) { return '<label for="' + id + '">' + label + '</label><input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(val || '') + '" autocomplete="off">'; }

  function apptCard(a, l, inLead) {
    var past = !a.result && Date.parse(a.starts_at) < Date.now();
    var h = '<div class="card" data-appt="' + a.id + '"><div class="row"><div class="grow">' +
      (inLead ? '' : '<div class="t" data-act="open" data-id="' + l.id + '">' + esc(title(l)) + '</div><div class="s">' + esc(l.address || L.formatPhone(l.phone)) + '</div>') +
      '<div class="' + (inLead ? 't' : 's') + '">' + esc(fmtWhen(a.starts_at)) + '</div></div>' +
      (past ? '<span class="chip late">Needs result</span>' : '') + '</div>' +
      '<div class="seg3" style="margin-top:8px">' + [['sat', 'Sat'], ['closed', 'Closed'], ['no_show', 'No-show']].map(function (r) {
        return '<button class="r-' + r[0] + (a.result === r[0] ? ' on' : '') + '" data-act="appt-result" data-id="' + a.id + '" data-r="' + r[0] + '">' + r[1] + '</button>';
      }).join('') + '</div>' +
      (l.address && !inLead ? '<div class="btns" style="margin-bottom:0"><a class="btn sm" target="_blank" rel="noopener" href="' + mapsUrl(l.address) + '">🧭 Navigate</a></div>' : '') + '</div>';
    return h;
  }
  views.appts = function () {
    var idx = suppIdx(), ids = {}; DB.list('leads').forEach(function (l) { ids[l.id] = l; });
    var all = DB.list('appointments').filter(function (a) { return ids[a.lead_id] && !L.isSuppressed(ids[a.lead_id], idx); });
    var needs = all.filter(function (a) { return !a.result && Date.parse(a.starts_at) < Date.now(); }).sort(function (a, b) { return Date.parse(a.starts_at) - Date.parse(b.starts_at); });
    var up = all.filter(function (a) { return !a.result && Date.parse(a.starts_at) >= Date.now(); }).sort(function (a, b) { return Date.parse(a.starts_at) - Date.parse(b.starts_at); });
    var done = all.filter(function (a) { return a.result; }).sort(function (a, b) { return Date.parse(b.starts_at) - Date.parse(a.starts_at); }).slice(0, 40);
    var sec = function (name, arr, emptyMsg) { return '<h2>' + name + ' <span class="count">' + arr.length + '</span></h2>' + (arr.length ? arr.map(function (a) { return apptCard(a, ids[a.lead_id]); }).join('') : (emptyMsg ? '<div class="empty">' + emptyMsg + '</div>' : '')); };
    var h = '<div class="small muted" style="margin:0 2px">Log a "Sit booked" to add one, then mark the result here.</div>';
    h += (needs.length ? sec('Needs result', needs) : '') + sec('Upcoming', up, 'No sits booked.') + (done.length ? sec('Results', done) : '');
    return { title: 'Appointments', html: h };
  };

  function periodLabel(r, period) {
    var o = { month: 'short', day: 'numeric' };
    if (period === 'day') return r.from.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    if (period === 'week') return r.from.toLocaleDateString([], o) + ' – ' + L.addDays(r.to, -1).toLocaleDateString([], o);
    return r.from.toLocaleDateString([], { month: 'long', year: 'numeric' });
  }
  views.stats = function () {
    var p = ui.statsPeriod, r = L.range(p, ui.statsOffset), T = DB.list('touches'), A = DB.list('appointments');
    var s = L.computeStats(T, A, r.from, r.to), cfg = DB.settings();
    var pct = function (v) { return v == null ? '—' : v + '%'; };
    var per = function (n, d) { return d > 0 && n > 0 ? (Math.round(d / n * 10) / 10) : '—'; };
    var h = '<div class="seg" style="margin-bottom:8px">' + [['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(function (x) { return '<button data-act="stats-period" data-p="' + x[0] + '" class="' + (p === x[0] ? 'on' : '') + '">' + x[1] + '</button>'; }).join('') + '</div>';
    h += '<div class="row" style="justify-content:space-between;margin:6px 0"><button class="btn sm" data-act="stats-nav" data-d="-1">‹</button><b id="stats-label">' + esc(periodLabel(r, p)) + '</b><button class="btn sm" data-act="stats-nav" data-d="1"' + (ui.statsOffset >= 0 ? ' disabled' : '') + '>›</button></div>';
    h += '<div class="grid"><div class="stat"><b id="st-doors">' + s.doors + '</b><span>Doors</span></div><div class="stat"><b id="st-calls">' + s.calls + '</b><span>Calls</span></div><div class="stat"><b id="st-conv">' + s.conversations + '</b><span>Conversations</span></div>' +
      '<div class="stat"><b id="st-sits">' + s.sits + '</b><span>Sits booked</span></div><div class="stat"><b id="st-sat">' + s.sat + '</b><span>Sat</span></div><div class="stat"><b id="st-closes">' + s.closes + '</b><span>Closes</span></div></div>';
    if (p === 'day') h += '<div class="small muted" style="margin-top:6px">Door target: ' + s.doors + ' / ' + cfg.target + '</div>';
    h += '<h2>Conversion</h2><div class="card"><table class="kv">' +
      '<tr><td>Conversation rate <span class="muted small">(talks ÷ doors+calls)</span></td><td>' + pct(L.rate(s.conversations, s.touches)) + '</td></tr>' +
      '<tr><td>Sit rate <span class="muted small">(sits ÷ talks)</span></td><td>' + pct(L.rate(s.sits, s.conversations)) + '</td></tr>' +
      '<tr><td>Show rate <span class="muted small">(sat ÷ sat+no-show)</span></td><td>' + pct(L.rate(s.sat, s.sat + s.noshow)) + '</td></tr>' +
      '<tr><td>Close rate <span class="muted small">(closes ÷ sat)</span></td><td>' + pct(L.rate(s.closes, s.sat)) + '</td></tr>' +
      '<tr><td>Touches per sit</td><td>' + per(s.sits, s.touches) + '</td></tr>' +
      '<tr><td>Touches per close</td><td>' + per(s.closes, s.touches) + '</td></tr></table></div>';
    // bars: doors+calls per day
    var days = [], start = p === 'day' ? L.addDays(r.from, -6) : r.from, n = p === 'day' ? 7 : Math.round((r.to - r.from) / 864e5);
    for (var i = 0; i < n; i++) days.push(L.addDays(start, i));
    var counts = days.map(function (d) { var e = L.addDays(d, 1), x = L.computeStats(T, [], d, e); return x.touches; }), max = Math.max.apply(null, counts.concat([1]));
    h += '<h2>Touches per day</h2><div class="card"><div class="bars">' + counts.map(function (c) { return '<div class="' + (c ? '' : 'zero') + '" title="' + c + '" style="height:' + Math.max(3, Math.round(c * 100 / max)) + '%"></div>'; }).join('') + '</div>' +
      '<div class="barlbl">' + days.map(function (d) { return '<span>' + (n > 8 ? d.getDate() : d.toLocaleDateString([], { weekday: 'narrow' })) + '</span>'; }).join('') + '</div></div>';
    var keys = Object.keys(s.byDisp).sort(function (a, b) { return s.byDisp[b] - s.byDisp[a]; });
    if (keys.length) h += '<h2>Outcomes</h2><div class="card"><table class="kv">' + keys.map(function (k) { var tp = k.split(':'); return '<tr><td>' + (tp[0] === 'call' ? '📞 ' : '🚪 ') + esc(L.dispLabel(tp[1], tp[0])) + '</td><td>' + s.byDisp[k] + '</td></tr>'; }).join('') + '</table></div>';
    return { title: 'Stats', html: h };
  };

  views.more = function () {
    var cfg = DB.settings();
    var h = '<h2>Tools</h2><a class="card row" href="#/import"><div class="grow"><div class="t">Import leads (CSV)</div><div class="s">Permit scrubs, RepCard exports, any spreadsheet</div></div>›</a>' +
      '<a class="card row" href="#/suppression"><div class="grow"><div class="t">Suppression list</div><div class="s">' + DB.list('suppression').length + ' hidden · Do not knock / Do not call</div></div>›</a>';
    h += '<h2>Settings</h2><div class="card"><label style="margin-top:0" for="set-target">Daily door target</label><input id="set-target" type="number" min="1" inputmode="numeric" value="' + cfg.target + '">' +
      '<label for="set-name">Your name</label><input id="set-name" value="' + esc(cfg.name) + '"></div>';
    h += '<h2>Backup</h2><div class="card"><div class="small muted wrap" style="margin-bottom:8px">Data lives only in this browser. Export a backup regularly until a cloud database is hooked up.</div>' +
      '<div class="btns"><button class="btn" data-act="export-json">Export all (JSON)</button></div>' +
      '<div class="btns"><button class="btn" data-act="export-csv" data-t="leads">Leads CSV</button><button class="btn" data-act="export-csv" data-t="touches">Touches CSV</button><button class="btn" data-act="export-csv" data-t="appointments">Appts CSV</button></div>' +
      '<label>Restore from JSON backup (merges)</label><input type="file" id="restore-file" accept=".json,application/json"></div>';
    h += '<h2>Danger zone</h2><div class="btns"><button class="btn danger" data-act="wipe">Erase all data on this device</button></div>';
    h += '<p class="muted small">Storage: ' + esc(window.__store || '') + ' · Owner ID: ' + esc((DB.ownerId() || '').slice(0, 8)) + ' · v1</p>';
    return { title: 'More', html: h };
  };

  views.suppression = function () {
    var ents = DB.list('suppression').slice().sort(function (a, b) { return Date.parse(b.added_at || b.created_at) - Date.parse(a.added_at || a.created_at); });
    var h = '<a href="#/more" class="muted small">‹ More</a><div class="small muted wrap" style="margin:6px 2px">Anything matching an address or phone here is hidden from every list, callbacks, search and import.</div>';
    h += '<div class="card"><label style="margin-top:0">Reason</label><select id="sp-reason"><option>Do not knock</option><option>Do not call</option></select><label>Address</label><input id="sp-address" placeholder="123 Main St"><label>Phone</label><input id="sp-phone" type="tel" placeholder="(410) 555-1234">' +
      '<div class="btns"><button class="btn primary" data-act="add-supp">Add to list</button></div></div>';
    h += '<h2>Hidden <span class="count">' + ents.length + '</span></h2>';
    h += ents.length ? ents.map(function (s) {
      return '<div class="card row"><div class="grow"><div class="t">' + esc(s.address || L.formatPhone(s.phone)) + '</div><div class="s">' + esc(s.reason || '') + (s.address && s.phone ? ' · ' + esc(L.formatPhone(s.phone)) : '') + ' · ' + esc(ago(s.added_at || s.created_at)) + '</div></div><button class="btn sm" data-act="restore-supp" data-id="' + s.id + '">Restore</button></div>';
    }).join('') : '<div class="empty">Nobody suppressed.</div>';
    return { title: 'Suppression', html: h };
  };

  views.import = function () {
    var h = '<a href="#/more" class="muted small">‹ More</a>';
    if (!imp || !imp.rows) {
      h += '<div class="card"><label style="margin-top:0">CSV file</label><input type="file" id="imp-file" accept=".csv,.tsv,.txt,text/csv"><label>…or paste CSV (with header row)</label><textarea id="imp-text" placeholder="name,address,phone&#10;Jane Doe,123 Main St,410-555-1212" style="min-height:120px"></textarea>' +
        '<div class="btns"><button class="btn primary" data-act="imp-parse">Next: map columns</button></div></div>';
    } else if (imp.result) {
      var r = imp.result;
      h += '<div class="ok"><b>Imported ' + r.added + ' lead' + (r.added === 1 ? '' : 's') + '.</b></div><div class="card"><table class="kv"><tr><td>Duplicates skipped</td><td>' + r.dupes + '</td></tr><tr><td>On suppression list (skipped)</td><td>' + r.supp + '</td></tr><tr><td>Empty rows skipped</td><td>' + r.empty + '</td></tr></table></div>' +
        '<div class="btns"><a class="btn primary" href="#/leads">View leads</a><button class="btn" data-act="imp-reset">Import another</button></div>';
    } else {
      var opts = function (sel) { return '<option value="">— none —</option>' + imp.headers.map(function (hd, i) { return '<option value="' + i + '"' + (String(sel) === String(i) ? ' selected' : '') + '>' + esc(hd || 'Column ' + (i + 1)) + '</option>'; }).join(''); };
      var F = [['name', 'Name (or first name)'], ['last_name', 'Last name'], ['address', 'Address / street'], ['city', 'City'], ['zip', 'ZIP'], ['phone', 'Phone'], ['email', 'Email'], ['utility', 'Utility'], ['roof_notes', 'Roof notes / notes'], ['source', 'Source']];
      h += '<div class="small muted" style="margin:6px 2px">' + imp.rows.length + ' rows found. Check the mapping, then import.</div><div class="card">' +
        F.map(function (f) { return '<label>' + f[1] + '</label><select data-map="' + f[0] + '">' + opts(imp.map[f[0]]) + '</select>'; }).join('') +
        '<label>Default source (when no source column)</label><input id="imp-source" value="' + esc(imp.source) + '"></div>';
      var pv = imp.rows.slice(0, 3).map(function (row) { return CSV.rowToLead(row, imp.map); });
      h += '<h2>Preview</h2>' + pv.map(function (l) { return '<div class="card"><div class="t">' + esc(l.name || '(no name)') + '</div><div class="s">' + esc(l.address) + ' · ' + esc(l.phone) + '</div></div>'; }).join('');
      h += '<div class="btns"><button class="btn primary" data-act="imp-run">Import ' + imp.rows.length + ' rows</button><button class="btn" data-act="imp-reset">Start over</button></div>';
    }
    return { title: 'Import', html: h };
  };

  /* ---------- router ---------- */
  function route() {
    var h = location.hash.replace(/^#\/?/, '') || 'today', parts = h.split('/'), name = parts[0], arg = parts[1];
    if (!views[name]) name = 'today';
    var v = views[name](arg);
    $('#top-title').textContent = v.title || '';
    $('#main').innerHTML = v.html;
    var tab = { today: 'today', leads: 'leads', lead: 'leads', appts: 'appts', stats: 'stats', more: 'more', import: 'more', suppression: 'more' }[name];
    document.querySelectorAll('#tabs a').forEach(function (a) { a.classList.toggle('on', a.dataset.tab === tab); });
    document.body.classList.toggle('nofab', name === 'lead' || name === 'import');
    window.scrollTo(0, 0);
  }
  function refresh() { var y = window.scrollY; route(); window.scrollTo(0, y); }

  /* ---------- log sheet ---------- */
  function defaultNext(kind) { var d = L.addDays(now(), 1); d.setHours(kind === 'sit_booked' ? 18 : 17, 0, 0, 0); return L.toLocalInput(d); }
  function openLog(opts) {
    opts = opts || {};
    LG = { type: opts.type || 'door', lead: opts.lead || null, query: '', name: '', other: '', disp: null, note: '', next: '', nextAuto: false };
    $('#sheet-root').innerHTML = '<div class="backdrop" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-label="Log touch">' +
      '<div class="sheet-head"><b>Log</b><button class="x" data-act="close-sheet" aria-label="Close">✕</button></div><div class="sheet-body">' +
      '<div class="seg" id="lg-type"></div><label>Lead</label><div id="lg-lead"></div>' +
      '<label>Outcome</label><div class="dgrid" id="lg-disp"></div>' +
      '<div id="lg-time"><label id="lg-next-label"></label><input type="datetime-local" id="lg-next"><div class="presets" id="lg-presets"></div></div>' +
      '<label>Note (optional)</label><textarea id="lg-note" placeholder="Anything to remember"></textarea></div>' +
      '<div class="sheet-foot"><button class="btn primary" id="lg-save" data-act="save-log" disabled>Save</button><button class="btn" id="lg-save2" data-act="save-log-next" disabled>Save + next</button></div></div>';
    document.body.classList.add('sheet-open');
    drawType(); drawLead(); drawDisp(); drawTime(); drawFoot();
    if (!LG.lead) $('#lg-q').focus();
  }
  function closeLog() { LG = null; $('#sheet-root').innerHTML = ''; document.body.classList.remove('sheet-open'); }
  function drawType() {
    $('#lg-type').innerHTML = ['door', 'call'].map(function (t) { return '<button data-act="set-type" data-t="' + t + '" class="' + (LG.type === t ? 'on' : '') + '">' + (t === 'door' ? '🚪 Door' : '📞 Call') + '</button>'; }).join('');
  }
  function drawLead() {
    var el = $('#lg-lead'), l = LG.lead;
    if (!l) { el.innerHTML = '<input id="lg-q" placeholder="Address or phone number" autocomplete="off" autocapitalize="words" value="' + esc(LG.query) + '"><div class="sugg" id="lg-sugg"></div>'; drawSugg(); return; }
    if (l.isNew) {
      el.innerHTML = '<div class="picked"><div class="grow"><div class="t">New: ' + esc(l.address || L.formatPhone(l.phone)) + '</div></div><button class="btn sm" data-act="change-lead">Change</button></div>' +
        '<input id="lg-name" placeholder="Name (optional)" style="margin-top:8px" value="' + esc(LG.name) + '">' +
        '<input id="lg-other" ' + (l.address ? 'type="tel" placeholder="Phone (optional)"' : 'placeholder="Address (optional)"') + ' style="margin-top:8px" value="' + esc(LG.other) + '">';
      return;
    }
    var last = leadTouches(l.id)[0];
    el.innerHTML = '<div class="picked"><div class="grow"><div class="t">' + esc(title(l)) + '</div><div class="s">' + esc(sub(l)) + '</div><div class="s">' + chipText(l) + (last ? ' · last: ' + esc(L.dispLabel(last.disposition, last.type)) + ' ' + esc(ago(last.created_at)) : ' · no touches') + '</div></div><button class="btn sm" data-act="change-lead">Change</button></div>';
  }
  function chipText(l) { return esc(L.STATUS[l.status] || l.status); }
  function drawSugg() {
    var el = $('#lg-sugg'); if (!el) return;
    var q = LG.query.trim(); if (!q) { el.innerHTML = ''; return; }
    var isPhone = L.looksLikePhone(q), qn = isPhone ? L.normPhone(q) : L.normAddr(q), ql = q.toLowerCase();
    var idx = suppIdx(), blocked = isPhone ? idx.phones.has(qn) : idx.addrs.has(qn);
    var leads = visibleLeads(), exact = null, matches = [];
    leads.forEach(function (l) {
      var hit = isPhone ? (L.normPhone(l.phone) && L.normPhone(l.phone).indexOf(qn) >= 0 && qn.length >= 7) || (l.phone || '').replace(/\D/g, '').indexOf(q.replace(/\D/g, '')) >= 0
        : (L.normAddr(l.address).indexOf(qn) >= 0 && qn) || (l.name || '').toLowerCase().indexOf(ql) >= 0;
      if (hit) { matches.push(l); if (isPhone ? L.normPhone(l.phone) === qn : L.normAddr(l.address) === qn) exact = l; }
    });
    matches = L.prioritySort(matches, now()).slice(0, 5);
    var h = '';
    if (blocked) h += '<div class="opt block"><b>⛔ ' + (isPhone ? 'Do not call' : 'Do not knock') + '</b><span>This ' + (isPhone ? 'number' : 'address') + ' is on your suppression list.</span></div>';
    else {
      h += matches.map(function (l) { return '<button class="opt" data-act="pick-lead" data-id="' + l.id + '"><b>' + esc(title(l)) + '</b><span class="s">' + esc(sub(l)) + ' · ' + chipText(l) + '</span></button>'; }).join('');
      if (!exact) h += '<button class="opt new" data-act="new-lead">+ New lead: ' + esc(isPhone ? L.formatPhone(q) : q) + '</button>';
    }
    el.innerHTML = h; el._first = blocked ? null : (matches[0] && (exact || matches.length === 1) ? matches[0] : null);
  }
  function drawDisp() {
    var keys = LG.type === 'call' ? L.CALL_DISPS : L.DOOR_DISPS;
    if (LG.disp && keys.indexOf(LG.disp) < 0) LG.disp = null;
    $('#lg-disp').innerHTML = keys.map(function (k) {
      var d = L.DISP[k]; return '<button data-act="pick-disp" data-d="' + k + '" class="tone-' + d.tone + (LG.disp === k ? ' on' : '') + '">' + esc(L.dispLabel(k, LG.type)) + '</button>';
    }).join('');
  }
  function drawTime() {
    var d = LG.disp && L.DISP[LG.disp], hide = d && (LG.disp === 'not_interested' || LG.disp === 'dnk' || LG.disp === 'wrong_number');
    $('#lg-time').style.display = hide ? 'none' : '';
    $('#lg-next-label').textContent = d && d.needsTime ? d.needsTime + ' (required)' : 'Next callback (optional)';
    $('#lg-next').value = LG.next;
    var n = now(), mk = function (label, dt) { return '<button data-act="preset" data-v="' + L.toLocalInput(dt) + '">' + label + '</button>'; };
    var at = function (days, hr) { var x = L.addDays(n, days); x.setHours(hr, 0, 0, 0); return x; };
    $('#lg-presets').innerHTML = mk('1 hr', new Date(+n + 36e5)) + (n.getHours() < 17 ? mk('Today 6pm', at(0, 18)) : '') + mk('Tomorrow 10am', at(1, 10)) + mk('Tomorrow 5pm', at(1, 17)) + mk('+3 days', at(3, 17)) + mk('+1 week', at(7, 17)) +
      (LG.next ? '<button data-act="preset" data-v="">Clear</button>' : '');
  }
  function drawFoot() {
    var ok = !!(LG.lead && LG.disp);
    $('#lg-save').disabled = !ok; $('#lg-save2').disabled = !ok;
  }
  function pickDisp(k) {
    LG.disp = k; var d = L.DISP[k];
    if (d.needsTime && !LG.next) { LG.next = defaultNext(k); LG.nextAuto = true; }
    else if (!d.needsTime && LG.nextAuto) { LG.next = ''; LG.nextAuto = false; }
    if (k === 'not_interested' || k === 'dnk' || k === 'wrong_number') { LG.next = ''; LG.nextAuto = false; }
    drawDisp(); drawTime(); drawFoot();
  }
  function saveLog(keepOpen) {
    if (!LG || !LG.lead || !LG.disp) return;
    var d = L.DISP[LG.disp], type = LG.type, nextIso = L.fromLocalInput(LG.next), nowIso = new Date().toISOString();
    if (d.needsTime && !nextIso) { toast(d.needsTime + ' is required', true); return; }
    var lead = LG.lead, p;
    if (lead.isNew) {
      var nm = ($('#lg-name') || {}).value || '', other = ($('#lg-other') || {}).value || '';
      lead = { name: nm.trim(), address: lead.address ? lead.address.trim() : other.trim(), phone: lead.phone ? lead.phone : other.trim(), email: '', utility: '', roof_notes: '', source: type === 'call' ? 'Phone' : 'Door knock', status: 'new', next_action_at: null, last_touch_at: null };
    } else lead = Object.assign({}, lead);
    var note = ($('#lg-note') || {}).value || '';
    var status = L.nextStatus(lead.status, LG.disp);
    if (nextIso && !(LG.disp === 'sit_booked') && status !== 'dnk') lead.next_action_at = nextIso;
    else if (!d.keepNext || LG.disp === 'sit_booked') lead.next_action_at = null;
    if (LG.disp === 'dnk' || LG.disp === 'not_interested' || LG.disp === 'wrong_number') lead.next_action_at = null;
    lead.status = status; lead.last_touch_at = nowIso;
    var typeNow = type, disp = LG.disp, sitIso = LG.disp === 'sit_booked' ? nextIso : null;
    p = DB.put('leads', lead).then(function (saved) {
      var jobs = [DB.put('touches', { lead_id: saved.id, type: typeNow, disposition: disp, note: note.trim(), next_action_at: nextIso || null, created_at: nowIso })];
      if (sitIso) jobs.push(DB.put('appointments', { lead_id: saved.id, starts_at: sitIso, result: null, result_at: null }));
      if (disp === 'dnk') jobs.push(addSuppression({ address: saved.address, phone: saved.phone, lead_id: saved.id, reason: typeNow === 'call' ? 'Do not call' : 'Do not knock' }));
      return Promise.all(jobs).then(function () { return saved; });
    }).then(function (saved) {
      toast('Saved · ' + L.dispLabel(disp, typeNow));
      if (keepOpen) { var t = LG.type; openLog({ type: t }); } else closeLog();
      refresh();
    }).catch(function (err) { console.error(err); toast('Save failed: ' + err.message, true); });
    return p;
  }
  function addSuppression(o) {
    var ex = DB.list('suppression').filter(function (s) { return (o.address && L.normAddr(s.address) === L.normAddr(o.address)) || (L.normPhone(o.phone) && L.normPhone(s.phone) === L.normPhone(o.phone)); })[0];
    if (ex) return Promise.resolve(ex);
    return DB.put('suppression', { address: o.address || '', phone: o.phone || '', lead_id: o.lead_id || null, reason: o.reason, added_at: new Date().toISOString() });
  }

  /* ---------- actions ---------- */
  var act = {};
  act.open = function (el) { location.hash = '#/lead/' + el.dataset.id; };
  act.log = function (el) { openLog({ lead: el.dataset.id ? DB.get('leads', el.dataset.id) : null }); };
  act['close-sheet'] = closeLog;
  act['set-type'] = function (el) { LG.type = el.dataset.t; drawType(); drawDisp(); drawFoot(); };
  act['pick-lead'] = function (el) { LG.lead = DB.get('leads', el.dataset.id); drawLead(); drawFoot(); };
  act['new-lead'] = function () {
    var q = LG.query.trim(); LG.lead = L.looksLikePhone(q) ? { isNew: true, phone: q } : { isNew: true, address: q };
    drawLead(); drawFoot();
  };
  act['change-lead'] = function () { LG.lead = null; LG.query = ''; drawLead(); drawFoot(); $('#lg-q').focus(); };
  act['pick-disp'] = function (el) { pickDisp(el.dataset.d); };
  act.preset = function (el) { LG.next = el.dataset.v; LG.nextAuto = false; drawTime(); };
  act['save-log'] = function () { saveLog(false); };
  act['save-log-next'] = function () { saveLog(true); };
  act.filter = function (el) { ui.filter = el.dataset.f; ui.limit = 60; $('#filters').querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.f === ui.filter); }); $('#leadlist').innerHTML = leadListHtml(); };
  act['more-leads'] = function () { ui.limit += 100; $('#leadlist').innerHTML = leadListHtml(); };
  act['save-lead'] = function (el) {
    var id = el.dataset.id, v = function (i) { return ($('#' + i).value || '').trim(); };
    var rec = { name: v('lf-name'), address: v('lf-address'), phone: v('lf-phone'), email: v('lf-email'), utility: v('lf-utility'), roof_notes: v('lf-roof'), source: v('lf-source'), status: $('#lf-status').value };
    if (!rec.name && !rec.address && !rec.phone) { toast('Add a name, address or phone', true); return; }
    if (id === 'new') {
      var idx = suppIdx();
      if (L.isSuppressed(rec, idx)) { toast('That address/phone is on the suppression list', true); return; }
      rec.last_touch_at = null; rec.next_action_at = null;
    } else rec.id = id;
    DB.put('leads', rec).then(function (s) { toast('Lead saved'); if (id === 'new') location.hash = '#/lead/' + s.id; else refresh(); });
  };
  act['save-next'] = function (el) { var iso = L.fromLocalInput($('#lf-next').value); DB.put('leads', { id: el.dataset.id, next_action_at: iso }).then(function () { toast(iso ? 'Next action set' : 'Cleared'); refresh(); }); };
  act['clear-next'] = function (el) { DB.put('leads', { id: el.dataset.id, next_action_at: null }).then(function () { toast('Cleared'); refresh(); }); };
  act['book-appt'] = function (el) {
    var iso = L.fromLocalInput($('#lf-sit').value); if (!iso) { toast('Pick a time', true); return; }
    var lead = DB.get('leads', el.dataset.id);
    Promise.all([DB.put('appointments', { lead_id: lead.id, starts_at: iso, result: null, result_at: null }),
      DB.put('leads', { id: lead.id, status: lead.status === 'closed' ? 'closed' : 'sit', next_action_at: null })]).then(function () { toast('Sit booked'); refresh(); });
  };
  act['appt-result'] = function (el) {
    var a = DB.get('appointments', el.dataset.id), r = el.dataset.r, res = a.result === r ? null : r;
    var st = { sat: 'sat', closed: 'closed', no_show: 'no_show' }[res] || 'sit';
    Promise.all([DB.put('appointments', { id: a.id, result: res, result_at: res ? new Date().toISOString() : null }), DB.put('leads', { id: a.lead_id, status: st })]).then(function () { toast(res ? 'Marked ' + res.replace('_', '-') : 'Result cleared'); refresh(); });
  };
  act['del-lead'] = function (el) {
    if (!confirm('Delete this lead and all its history? This cannot be undone.')) return;
    var id = el.dataset.id;
    Promise.all([DB.remove('leads', id), DB.removeWhere('touches', function (t) { return t.lead_id === id; }), DB.removeWhere('appointments', function (a) { return a.lead_id === id; })]).then(function () { toast('Deleted'); location.hash = '#/leads'; });
  };
  act['stats-period'] = function (el) { ui.statsPeriod = el.dataset.p; ui.statsOffset = 0; refresh(); };
  act['stats-nav'] = function (el) { ui.statsOffset = Math.min(0, ui.statsOffset + Number(el.dataset.d)); refresh(); };
  act['add-supp'] = function () {
    var a = $('#sp-address').value.trim(), p = $('#sp-phone').value.trim();
    if (!a && !L.normPhone(p)) { toast('Enter an address or phone', true); return; }
    addSuppression({ address: a, phone: p, reason: $('#sp-reason').value }).then(function () { toast('Added'); refresh(); });
  };
  act['restore-supp'] = function (el) {
    var s = DB.get('suppression', el.dataset.id); if (!s) return;
    DB.remove('suppression', s.id).then(function () {
      var sp = L.normPhone(s.phone), sa = L.normAddr(s.address);
      var back = DB.list('leads').filter(function (l) { return l.status === 'dnk' && ((sp && L.normPhone(l.phone) === sp) || (sa && L.normAddr(l.address) === sa) || l.id === s.lead_id); });
      return DB.putMany('leads', back.map(function (l) { return { id: l.id, status: 'contacted' }; }));
    }).then(function () { toast('Restored'); refresh(); });
  };
  act['export-json'] = function () { download('d2d-crm-backup-' + L.toLocalInput(now()).slice(0, 10) + '.json', JSON.stringify(DB.exportAll(), null, 2), 'application/json'); toast('Backup downloaded'); };
  act['export-csv'] = function (el) {
    var t = el.dataset.t, leads = {}; DB.list('leads').forEach(function (l) { leads[l.id] = l; });
    var rows;
    if (t === 'leads') {
      var cols = ['id', 'name', 'address', 'phone', 'email', 'utility', 'roof_notes', 'source', 'status', 'next_action_at', 'last_touch_at', 'owner_id', 'user_id', 'created_at'];
      rows = [cols].concat(DB.list('leads').map(function (l) { return cols.map(function (c) { return l[c]; }); }));
    } else if (t === 'touches') {
      rows = [['id', 'lead_id', 'lead_name', 'lead_address', 'type', 'disposition', 'note', 'next_action_at', 'created_at', 'user_id']].concat(DB.list('touches').map(function (x) { var l = leads[x.lead_id] || {}; return [x.id, x.lead_id, l.name, l.address, x.type, x.disposition, x.note, x.next_action_at, x.created_at, x.user_id]; }));
    } else {
      rows = [['id', 'lead_id', 'lead_name', 'lead_address', 'starts_at', 'result', 'result_at', 'owner_id']].concat(DB.list('appointments').map(function (a) { var l = leads[a.lead_id] || {}; return [a.id, a.lead_id, l.name, l.address, a.starts_at, a.result, a.result_at, a.owner_id]; }));
    }
    download('d2d-' + t + '.csv', CSV.stringify(rows), 'text/csv'); toast(t + ' CSV downloaded');
  };
  act.wipe = function () {
    if (!confirm('Erase ALL leads, touches and appointments on this device? Export a backup first.')) return;
    DB.wipe().then(function () { toast('All data erased'); refresh(); });
  };
  act['imp-parse'] = function () {
    var text = $('#imp-text').value, f = $('#imp-file').files[0];
    var go = function (txt) {
      var rows = CSV.parse(txt);
      if (rows.length < 2) { toast('Need a header row and at least one data row', true); return; }
      imp = { headers: rows[0].map(function (h) { return h.trim(); }), rows: rows.slice(1), map: CSV.guessMap(rows[0]), source: 'Import ' + L.toLocalInput(now()).slice(0, 10), result: null };
      refresh();
    };
    if (f) f.text().then(go); else if (text.trim()) go(text); else toast('Choose a file or paste CSV', true);
  };
  act['imp-reset'] = function () { imp = null; refresh(); };
  act['imp-run'] = function () {
    var src = $('#imp-source').value.trim() || 'Import', idx = suppIdx(), seenP = new Set(), seenA = new Set();
    DB.list('leads').forEach(function (l) { var p = L.normPhone(l.phone), a = L.normAddr(l.address); if (p) seenP.add(p); if (a) seenA.add(a); });
    var out = [], dupes = 0, supp = 0, empty = 0, base = Date.now();
    imp.rows.forEach(function (row, i) {
      var l = CSV.rowToLead(row, imp.map);
      if (!l.name && !l.address && !l.phone) { empty++; return; }
      if (L.isSuppressed(l, idx)) { supp++; return; }
      var p = L.normPhone(l.phone), a = L.normAddr(l.address);
      if ((p && seenP.has(p)) || (a && seenA.has(a))) { dupes++; return; }
      if (p) seenP.add(p); if (a) seenA.add(a);
      out.push(Object.assign(l, { source: l.source || src, status: 'new', next_action_at: null, last_touch_at: null, created_at: new Date(base - i).toISOString() }));
    });
    DB.putMany('leads', out).then(function () { imp.result = { added: out.length, dupes: dupes, supp: supp, empty: empty }; refresh(); });
  };

  /* ---------- events ---------- */
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]'); if (!el) return;
    if (e.target.closest('a[href]') && el !== e.target.closest('a[href]')) return; // links inside cards win
    var fn = act[el.dataset.act]; if (fn) { fn(el, e); }
  });
  document.addEventListener('input', function (e) {
    var id = e.target.id;
    if (id === 'lg-q') { LG.query = e.target.value; drawSugg(); }
    else if (id === 'lg-name') LG.name = e.target.value;
    else if (id === 'lg-other') LG.other = e.target.value;
    else if (id === 'lg-note') LG.note = e.target.value;
    else if (id === 'lg-next') { LG.next = e.target.value; LG.nextAuto = false; }
    else if (id === 'lead-q') { ui.q = e.target.value; ui.limit = 60; $('#leadlist').innerHTML = leadListHtml(); }
  });
  document.addEventListener('change', function (e) {
    var t = e.target, id = t.id;
    if (id === 'set-target') { var n = parseInt(t.value, 10); if (n > 0) { DB.setSettings({ target: n }); toast('Target saved'); } }
    else if (id === 'set-name') DB.setSettings({ name: t.value.trim() || 'Magnus' });
    else if (id === 'restore-file' && t.files[0]) {
      t.files[0].text().then(function (txt) { return DB.importAll(JSON.parse(txt)); }).then(function (n) { toast('Restored ' + n + ' records'); refresh(); }).catch(function (err) { toast(err.message, true); });
    } else if (t.dataset && t.dataset.map) { imp.map[t.dataset.map] = t.value === '' ? undefined : Number(t.value); imp.source = ($('#imp-source') || {}).value || imp.source; refresh(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && LG) closeLog();
    if (e.key === 'Enter' && e.target.id === 'lg-q') {
      e.preventDefault(); var s = $('#lg-sugg');
      if (s && s._first) { LG.lead = s._first; drawLead(); drawFoot(); }
      else if (s && s.querySelector('.opt.new')) act['new-lead']();
    }
  });
  window.addEventListener('hashchange', route);

  /* ---------- boot ---------- */
  DB.init().then(function (name) {
    window.__store = name; route();
    window.__ready = true;
  }).catch(function (err) { $('#main').innerHTML = '<div class="warn">Could not open storage: ' + esc(err.message) + '</div>'; });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () { navigator.serviceWorker.register('./sw.js').catch(function (e) { console.warn('SW failed', e); }); });
  }
  window.__app = { openLog: openLog, route: route };
})();
