/**
 * TS8 Firestore realtime sync (compat CDN, no build step).
 * Collections: projects/{id}, fsi_cases/{id}, meta/sync {updatedAt, rev, appMeta?, fsiMeta?}
 * Keeps in-memory db shape { projects, meta, fsi:{ cases, meta } }.
 */
(function (global) {
  'use strict';

  var DEBOUNCE_MS = 800;
  var BATCH_LIMIT = 400;
  var WRITE_SUPPRESS_MS = 800;

  var fsDb = null;
  var started = false;
  var opts = null;
  var pushTimer = null;
  var writing = false;
  var applyingRemote = false;
  var lastLocalWriteAt = '';
  var unsubs = [];
  var cacheProjects = new Map();
  var cacheCases = new Map();
  var cacheSync = null;
  var ready = { projects: false, cases: false, sync: false };

  function firebaseCfg() {
    var c = global.TS8_CONFIG && global.TS8_CONFIG.FIREBASE;
    return c && c.apiKey && c.projectId ? c : null;
  }

  function enabled() {
    return !!firebaseCfg() && typeof global.firebase !== 'undefined' && !!global.firebase.firestore;
  }

  function setStatus(t) {
    if (opts && typeof opts.setStatus === 'function') opts.setStatus(t);
  }

  function stripUndefined(value) {
    if (value === undefined) return undefined;
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      return value.map(stripUndefined).filter(function (x) { return x !== undefined; });
    }
    var out = {};
    Object.keys(value).forEach(function (k) {
      var v = stripUndefined(value[k]);
      if (v !== undefined) out[k] = v;
    });
    return out;
  }

  function initFs() {
    if (fsDb) return fsDb;
    if (!enabled()) throw new Error('Firebase Firestore 未設定或 SDK 未載入');
    var cfg = firebaseCfg();
    if (!global.firebase.apps.length) global.firebase.initializeApp(cfg);
    fsDb = global.firebase.firestore();
    return fsDb;
  }

  function getDb() {
    return opts && typeof opts.getDb === 'function' ? opts.getDb() : { projects: [], meta: {}, fsi: { cases: [], meta: {} } };
  }

  function migrate(raw) {
    if (opts && typeof opts.migrateDb === 'function') return opts.migrateDb(raw);
    return raw;
  }

  async function isEmpty() {
    var fs = initFs();
    var results = await Promise.all([
      fs.collection('projects').limit(1).get(),
      fs.collection('fsi_cases').limit(1).get(),
      fs.doc('meta/sync').get()
    ]);
    return results[0].empty && results[1].empty && !results[2].exists;
  }

  function assembleDb() {
    var sync = cacheSync || {};
    var appMeta = sync.appMeta && typeof sync.appMeta === 'object' ? sync.appMeta : {};
    var fsiMeta = sync.fsiMeta && typeof sync.fsiMeta === 'object' ? sync.fsiMeta : {};
    var meta = Object.assign({}, appMeta, {
      updatedAt: sync.updatedAt || appMeta.updatedAt || '',
      rev: sync.rev != null ? sync.rev : (appMeta.rev || 0)
    });
    return {
      projects: Array.from(cacheProjects.values()),
      meta: meta,
      fsi: {
        cases: Array.from(cacheCases.values()),
        meta: fsiMeta
      }
    };
  }

  function shouldIgnoreRemote() {
    if (writing || applyingRemote) return true;
    var at = cacheSync && cacheSync.updatedAt;
    if (at && lastLocalWriteAt && at === lastLocalWriteAt) return true;
    return false;
  }

  function emitRemoteIfReady() {
    if (!ready.projects || !ready.cases || !ready.sync) return;
    if (shouldIgnoreRemote()) {
      setStatus('已同步');
      return;
    }
    var assembled = migrate(assembleDb());
    applyingRemote = true;
    try {
      if (opts && typeof opts.onRemote === 'function') opts.onRemote(assembled);
      setStatus('已同步');
    } catch (err) {
      console.warn('[TS8FirestoreSync] onRemote failed', err);
      setStatus('同步失敗');
    } finally {
      applyingRemote = false;
    }
  }

  async function runBatches(ops) {
    var fs = initFs();
    for (var i = 0; i < ops.length; i += BATCH_LIMIT) {
      var slice = ops.slice(i, i + BATCH_LIMIT);
      var batch = fs.batch();
      slice.forEach(function (fn) { fn(batch); });
      await batch.commit();
    }
  }

  async function writeFullDb(fullDb) {
    var fs = initFs();
    var data = migrate(fullDb || getDb());
    var projects = Array.isArray(data.projects) ? data.projects : [];
    var cases = (data.fsi && Array.isArray(data.fsi.cases)) ? data.fsi.cases : [];
    var meta = data.meta && typeof data.meta === 'object' ? data.meta : {};
    var fsiMeta = (data.fsi && data.fsi.meta && typeof data.fsi.meta === 'object') ? data.fsi.meta : {};

    if (!meta.updatedAt) meta.updatedAt = new Date().toISOString();
    meta.rev = (meta.rev | 0);

    writing = true;
    setStatus('即時同步中');
    try {
      var existing = await Promise.all([
        fs.collection('projects').get(),
        fs.collection('fsi_cases').get()
      ]);
      var localP = {};
      var localC = {};
      projects.forEach(function (p) { if (p && p.id) localP[p.id] = true; });
      cases.forEach(function (c) { if (c && c.id) localC[c.id] = true; });

      var ops = [];
      projects.forEach(function (p) {
        if (!p || !p.id) return;
        var payload = stripUndefined(Object.assign({}, p, { id: p.id }));
        ops.push(function (batch) {
          batch.set(fs.collection('projects').doc(p.id), payload);
        });
      });
      cases.forEach(function (c) {
        if (!c || !c.id) return;
        var payload = stripUndefined(Object.assign({}, c, { id: c.id }));
        ops.push(function (batch) {
          batch.set(fs.collection('fsi_cases').doc(c.id), payload);
        });
      });
      existing[0].forEach(function (doc) {
        if (!localP[doc.id]) {
          ops.push(function (batch) { batch.delete(doc.ref); });
        }
      });
      existing[1].forEach(function (doc) {
        if (!localC[doc.id]) {
          ops.push(function (batch) { batch.delete(doc.ref); });
        }
      });

      var syncDoc = stripUndefined({
        updatedAt: meta.updatedAt,
        rev: meta.rev | 0,
        appMeta: meta,
        fsiMeta: fsiMeta
      });
      lastLocalWriteAt = syncDoc.updatedAt;
      ops.push(function (batch) {
        batch.set(fs.doc('meta/sync'), syncDoc);
      });

      await runBatches(ops);
      setStatus('已同步');
      return true;
    } catch (err) {
      console.warn('[TS8FirestoreSync] write failed', err);
      setStatus('同步失敗');
      return false;
    } finally {
      setTimeout(function () { writing = false; }, WRITE_SUPPRESS_MS);
    }
  }

  function schedulePush() {
    if (!enabled() || !started) return;
    setStatus('即時同步中');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      writeFullDb(getDb());
    }, DEBOUNCE_MS);
  }

  async function pushNow() {
    clearTimeout(pushTimer);
    pushTimer = null;
    return writeFullDb(getDb());
  }

  async function fetchLegacy() {
    if (opts && typeof opts.fetchLegacyDb === 'function') {
      try {
        return await opts.fetchLegacyDb();
      } catch (err) {
        console.warn('[TS8FirestoreSync] legacy fetch failed', err);
        return null;
      }
    }
    return null;
  }

  async function migrateOnceFromLegacy() {
    setStatus('即時同步中');
    var legacy = await fetchLegacy();
    if (!legacy) legacy = getDb();
    legacy = migrate(legacy);
    var ok = await writeFullDb(legacy);
    if (ok && opts && typeof opts.onRemote === 'function') {
      // Ensure in-memory db matches what we migrated (without waiting for snapshot).
      applyingRemote = true;
      try { opts.onRemote(legacy); } finally { applyingRemote = false; }
    }
    return ok;
  }

  function listen() {
    var fs = initFs();
    unsubs.forEach(function (u) { try { u(); } catch (_) {} });
    unsubs = [];
    ready = { projects: false, cases: false, sync: false };
    cacheProjects = new Map();
    cacheCases = new Map();
    cacheSync = null;

    unsubs.push(fs.collection('projects').onSnapshot(function (snap) {
      cacheProjects = new Map();
      snap.forEach(function (doc) {
        var data = doc.data() || {};
        cacheProjects.set(doc.id, Object.assign({}, data, { id: doc.id }));
      });
      ready.projects = true;
      emitRemoteIfReady();
    }, function (err) {
      console.warn('[TS8FirestoreSync] projects listen', err);
      setStatus('同步失敗');
    }));

    unsubs.push(fs.collection('fsi_cases').onSnapshot(function (snap) {
      cacheCases = new Map();
      snap.forEach(function (doc) {
        var data = doc.data() || {};
        cacheCases.set(doc.id, Object.assign({}, data, { id: doc.id }));
      });
      ready.cases = true;
      emitRemoteIfReady();
    }, function (err) {
      console.warn('[TS8FirestoreSync] fsi_cases listen', err);
      setStatus('同步失敗');
    }));

    unsubs.push(fs.doc('meta/sync').onSnapshot(function (snap) {
      cacheSync = snap.exists ? (snap.data() || {}) : {};
      ready.sync = true;
      emitRemoteIfReady();
    }, function (err) {
      console.warn('[TS8FirestoreSync] meta/sync listen', err);
      setStatus('同步失敗');
    }));
  }

  async function start(options) {
    opts = options || {};
    if (!enabled()) return { enabled: false, migrated: false };
    initFs();
    setStatus('即時同步中');
    var empty = await isEmpty();
    var migrated = false;
    if (empty) {
      migrated = await migrateOnceFromLegacy();
    }
    listen();
    started = true;
    if (!empty) setStatus('即時同步中');
    return { enabled: true, migrated: !!migrated, wasEmpty: empty };
  }

  function stop() {
    clearTimeout(pushTimer);
    pushTimer = null;
    unsubs.forEach(function (u) { try { u(); } catch (_) {} });
    unsubs = [];
    started = false;
  }

  global.TS8FirestoreSync = {
    enabled: enabled,
    start: start,
    stop: stop,
    schedulePush: schedulePush,
    pushNow: pushNow,
    isStarted: function () { return started; }
  };
})(typeof window !== 'undefined' ? window : this);
