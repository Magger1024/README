/* Data layer. All app code talks to window.DB only.
 * Storage today: IndexedDB (falls back to localStorage), in-memory cache for fast reads.
 * To move to Supabase later: re-implement this same interface (init/list/get/put/putMany/remove/removeWhere/
 * exportAll/importAll/wipe/ownerId/settings) against supabase-js and keep the rest of the app untouched.
 * Every record carries owner_id and user_id. */
(function () {
  'use strict';
  var TABLES = ['leads', 'touches', 'appointments', 'suppression', 'users'];
  var mem = {}, maps = {};
  TABLES.forEach(function (t) { mem[t] = []; maps[t] = new Map(); });
  var backend = null, ownerId = null;
  var SETTINGS_KEY = 'd2d-crm:settings';
  var DEFAULTS = { target: 125, name: 'Magnus' };

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function idbBackend() {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) return rej(new Error('no indexedDB'));
      var rq;
      try { rq = indexedDB.open('d2d-crm', 1); } catch (err) { return rej(err); }
      rq.onupgradeneeded = function () {
        var db = rq.result;
        TABLES.forEach(function (t) { if (!db.objectStoreNames.contains(t)) db.createObjectStore(t, { keyPath: 'id' }); });
      };
      rq.onerror = function () { rej(rq.error); };
      rq.onsuccess = function () {
        var db = rq.result;
        res({
          name: 'indexeddb',
          loadAll: function () {
            return Promise.all(TABLES.map(function (t) {
              return new Promise(function (ok, no) {
                var r = db.transaction(t).objectStore(t).getAll();
                r.onsuccess = function () { ok([t, r.result]); };
                r.onerror = function () { no(r.error); };
              });
            })).then(function (pairs) { var o = {}; pairs.forEach(function (p) { o[p[0]] = p[1]; }); return o; });
          },
          write: function (ops) {
            return new Promise(function (ok, no) {
              var names = []; ops.forEach(function (o) { if (names.indexOf(o.t) < 0) names.push(o.t); });
              if (!names.length) return ok();
              var tx = db.transaction(names, 'readwrite');
              ops.forEach(function (o) {
                var st = tx.objectStore(o.t);
                if (o.clear) st.clear(); else if (o.del) st.delete(o.del); else st.put(o.put);
              });
              tx.oncomplete = function () { ok(); };
              tx.onerror = function () { no(tx.error); };
              tx.onabort = function () { no(tx.error); };
            });
          }
        });
      };
    });
  }

  function lsBackend() {
    return {
      name: 'localstorage',
      loadAll: function () {
        var o = {};
        TABLES.forEach(function (t) { try { o[t] = JSON.parse(localStorage.getItem('d2d-crm:' + t) || '[]'); } catch (e) { o[t] = []; } });
        return Promise.resolve(o);
      },
      write: function (ops) {
        var names = {}; ops.forEach(function (o) { names[o.t] = 1; });
        Object.keys(names).forEach(function (t) { localStorage.setItem('d2d-crm:' + t, JSON.stringify(mem[t])); });
        return Promise.resolve();
      }
    };
  }

  function setMem(t, rows) {
    mem[t] = rows.slice(); maps[t] = new Map();
    mem[t].forEach(function (r) { maps[t].set(r.id, r); });
  }
  function store(t, r) {
    var old = maps[t].get(r.id);
    if (old) mem[t][mem[t].indexOf(old)] = r; else mem[t].push(r);
    maps[t].set(r.id, r);
  }
  function stamp(t, rec, now) {
    var r = Object.assign({}, maps[t].get(rec.id) || {}, rec);
    if (!r.id) r.id = uid();
    if (t !== 'users') { if (!r.owner_id) r.owner_id = ownerId; if (!r.user_id) r.user_id = ownerId; }
    if (!r.created_at) r.created_at = now;
    r.updated_at = now;
    return r;
  }

  var DB = {
    uid: uid,
    init: function () {
      return idbBackend().catch(function () { return lsBackend(); }).then(function (b) {
        backend = b;
        return b.loadAll();
      }).then(function (data) {
        TABLES.forEach(function (t) { setMem(t, data[t] || []); });
        if (!mem.users.length) {
          var id = uid(), now = new Date().toISOString();
          var u = { id: id, name: DB.settings().name, role: 'owner', owner_id: id, user_id: id, created_at: now, updated_at: now };
          store('users', u);
          return backend.write([{ t: 'users', put: u }]);
        }
      }).then(function () {
        var owner = mem.users.filter(function (u) { return u.role === 'owner'; })[0] || mem.users[0];
        ownerId = owner.id;
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
        return backend.name;
      });
    },
    ownerId: function () { return ownerId; },
    list: function (t) { return mem[t]; },
    get: function (t, id) { return maps[t].get(id) || null; },
    put: function (t, rec) {
      var r = stamp(t, rec, new Date().toISOString());
      store(t, r);
      return backend.write([{ t: t, put: r }]).then(function () { return r; });
    },
    putMany: function (t, recs) {
      var now = new Date().toISOString(), out = [];
      recs.forEach(function (rec) { var r = stamp(t, rec, now); store(t, r); out.push(r); });
      return backend.write(out.map(function (r) { return { t: t, put: r }; })).then(function () { return out; });
    },
    remove: function (t, id) {
      var old = maps[t].get(id); if (!old) return Promise.resolve();
      mem[t].splice(mem[t].indexOf(old), 1); maps[t].delete(id);
      return backend.write([{ t: t, del: id }]);
    },
    removeWhere: function (t, fn) {
      var gone = mem[t].filter(fn);
      gone.forEach(function (r) { maps[t].delete(r.id); });
      mem[t] = mem[t].filter(function (r) { return !fn(r); });
      return backend.write(gone.map(function (r) { return { t: t, del: r.id }; }));
    },
    settings: function () {
      var s = {}; try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) {}
      return Object.assign({}, DEFAULTS, s);
    },
    setSettings: function (patch) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(Object.assign(DB.settings(), patch)));
    },
    exportAll: function () {
      return {
        app: 'd2d-crm', version: 1, exported_at: new Date().toISOString(), owner_id: ownerId,
        settings: DB.settings(),
        leads: mem.leads, touches: mem.touches, appointments: mem.appointments, suppression: mem.suppression, users: mem.users
      };
    },
    importAll: function (obj) { // merge by id
      if (!obj || obj.app !== 'd2d-crm') return Promise.reject(new Error('Not a D2D CRM backup file'));
      var ops = [], n = 0;
      ['leads', 'touches', 'appointments', 'suppression'].forEach(function (t) {
        (obj[t] || []).forEach(function (r) {
          if (!r.id) return;
          if (!r.owner_id) r.owner_id = ownerId; if (!r.user_id) r.user_id = ownerId;
          store(t, r); ops.push({ t: t, put: r }); n++;
        });
      });
      if (obj.settings) DB.setSettings(obj.settings);
      return backend.write(ops).then(function () { return n; });
    },
    wipe: function () {
      var ops = [];
      ['leads', 'touches', 'appointments', 'suppression'].forEach(function (t) { setMem(t, []); ops.push({ t: t, clear: true }); });
      return backend.write(ops);
    }
  };
  window.DB = DB;
})();
