/**
 * TS8 Firestore realtime sync (compat CDN, no build step).
 * Collections: projects/{id}, fsi_cases/{id}, meta/sync {updatedAt, rev, appMeta?, fsiMeta?}
 * Keeps in-memory db shape { projects, meta, fsi:{ cases, meta } }.
 * Pushes are incremental: only changed/deleted docs + meta when needed.
 *
 * start({ scope: 'projects' | 'fsi' | 'all' }) — default 'all'.
 *   projects: listen/write projects + meta/sync (appMeta); keep local fsi without listening.
 *   fsi:      listen/write fsi_cases + meta/sync (fsiMeta); keep local projects without listening.
 *   all:      listen/write both collections (legacy / safety default).
 */
(function (global) {
  'use strict';

  var DEBOUNCE_MS = 280;
  var BATCH_LIMIT = 400;
  /** Brief guard while a write is in flight; echo suppression uses updatedAt match. */
  var WRITE_SUPPRESS_MS = 300;

  var fsDb = null;
  var started = false;
  var opts = null;
  /** @type {'projects'|'fsi'|'all'} */
  var scope = 'all';
  var pushTimer = null;
  var writing = false;
  var applyingRemote = false;
  var lastLocalWriteAt = '';
  var unsubs = [];
  var remoteRaf = null;
  var cacheProjects = new Map();
  var cacheCases = new Map();
  var cacheSync = null;
  var ready = { projects: false, cases: false, sync: false };
  /** id -> stable JSON of last successfully pushed (or remotely applied) doc */
  var lastPushedProjects = new Map();
  var lastPushedCases = new Map();
  var lastPushedSyncJson = '';

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

  function wantsProjects() {
    return scope === 'all' || scope === 'projects';
  }

  function wantsFsi() {
    return scope === 'all' || scope === 'fsi';
  }

  function normalizeScope(s) {
    if (s === 'projects' || s === 'fsi' || s === 'all') return s;
    return 'all';
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

  function stableJson(value) {
    return JSON.stringify(stripUndefined(value));
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

  /** Scope-aware emptiness: only the collections this page owns. */
  async function isEmpty() {
    var fs = initFs();
    if (scope === 'projects') {
      var p = await fs.collection('projects').limit(1).get();
      return p.empty;
    }
    if (scope === 'fsi') {
      var c = await fs.collection('fsi_cases').limit(1).get();
      return c.empty;
    }
    var results = await Promise.all([
      fs.collection('projects').limit(1).get(),
      fs.collection('fsi_cases').limit(1).get(),
      fs.doc('meta/sync').get()
    ]);
    return results[0].empty && results[1].empty && !results[2].exists;
  }

  function assembleDb() {
    var local = getDb() || {};
    var sync = cacheSync || {};
    var appMeta = sync.appMeta && typeof sync.appMeta === 'object' ? sync.appMeta : {};
    var fsiMetaFromSync = sync.fsiMeta && typeof sync.fsiMeta === 'object' ? sync.fsiMeta : {};
    var meta = Object.assign({}, appMeta, {
      updatedAt: sync.updatedAt || appMeta.updatedAt || '',
      rev: sync.rev != null ? sync.rev : (appMeta.rev || 0)
    });

    var projects;
    if (wantsProjects()) {
      projects = Array.from(cacheProjects.values());
    } else {
      projects = Array.isArray(local.projects) ? local.projects : [];
    }

    var cases;
    var fsiMeta;
    if (wantsFsi()) {
      cases = Array.from(cacheCases.values());
      fsiMeta = fsiMetaFromSync;
    } else {
      // projects scope: keep whatever local had for FSI (do not blank from empty cache)
      var localFsi = local.fsi && typeof local.fsi === 'object' ? local.fsi : {};
      cases = Array.isArray(localFsi.cases) ? localFsi.cases : [];
      fsiMeta = localFsi.meta && typeof localFsi.meta === 'object' ? localFsi.meta : {};
    }

    return {
      projects: projects,
      meta: meta,
      fsi: {
        cases: cases,
        meta: fsiMeta
      }
    };
  }

  function buildSyncDoc(meta, fsiMeta) {
    return stripUndefined({
      updatedAt: meta.updatedAt,
      rev: meta.rev | 0,
      appMeta: meta,
      fsiMeta: fsiMeta
    });
  }

  /**
   * Build meta/sync payload for the active scope without wiping the other side's fields.
   * projects → write appMeta + top-level clocks; preserve existing fsiMeta.
   * fsi      → write fsiMeta + top-level clocks; preserve existing appMeta.
   * all      → write both.
   */
  function buildSyncDocForScope(meta, fsiMeta) {
    var existing = cacheSync && typeof cacheSync === 'object' ? cacheSync : {};
    if (scope === 'projects') {
      return stripUndefined({
        updatedAt: meta.updatedAt,
        rev: meta.rev | 0,
        appMeta: meta,
        fsiMeta: (existing.fsiMeta && typeof existing.fsiMeta === 'object') ? existing.fsiMeta : (fsiMeta || {})
      });
    }
    if (scope === 'fsi') {
      return stripUndefined({
        updatedAt: meta.updatedAt,
        rev: meta.rev | 0,
        appMeta: (existing.appMeta && typeof existing.appMeta === 'object') ? existing.appMeta : {},
        fsiMeta: fsiMeta
      });
    }
    return buildSyncDoc(meta, fsiMeta);
  }

  function markLastPushedFromCaches() {
    if (wantsProjects()) {
      var nextP = new Map();
      cacheProjects.forEach(function (v, id) {
        nextP.set(id, stableJson(Object.assign({}, v, { id: id })));
      });
      lastPushedProjects = nextP;
    }
    if (wantsFsi()) {
      var nextC = new Map();
      cacheCases.forEach(function (v, id) {
        nextC.set(id, stableJson(Object.assign({}, v, { id: id })));
      });
      lastPushedCases = nextC;
    }
    if (cacheSync && typeof cacheSync === 'object') {
      lastPushedSyncJson = stableJson(cacheSync);
    }
  }

  function markLastPushedFromWrite(localP, localC, syncDoc) {
    if (wantsProjects() && localP) {
      var nextP = new Map();
      Object.keys(localP).forEach(function (id) {
        nextP.set(id, localP[id].json);
      });
      lastPushedProjects = nextP;
    }
    if (wantsFsi() && localC) {
      var nextC = new Map();
      Object.keys(localC).forEach(function (id) {
        nextC.set(id, localC[id].json);
      });
      lastPushedCases = nextC;
    }
    lastPushedSyncJson = stableJson(syncDoc);
  }

  function scheduleEmitRemote() {
    if (remoteRaf != null) return;
    remoteRaf = requestAnimationFrame(function () {
      remoteRaf = null;
      emitRemoteIfReady();
    });
  }

  function emitRemoteIfReady() {
    if (!ready.projects || !ready.cases || !ready.sync) return;
    if (applyingRemote || writing) {
      // Do not refresh lastPushed from caches mid-write (may be stale).
      return;
    }
    var at = cacheSync && cacheSync.updatedAt;
    if (at && lastLocalWriteAt && at === lastLocalWriteAt) {
      // Own-write echo: align baseline, skip onRemote to avoid UI churn.
      markLastPushedFromCaches();
      setStatus('已同步');
      return;
    }
    var assembled = migrate(assembleDb());
    applyingRemote = true;
    try {
      if (opts && typeof opts.onRemote === 'function') opts.onRemote(assembled);
      markLastPushedFromCaches();
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

  /**
   * Incremental push: only set changed docs, delete removed ids, update meta/sync when needed.
   * Scoped: only diffs the collections owned by the current scope.
   * forceFull=true: write every local doc in scope (migration / empty DB bootstrap).
   */
  async function writeDb(fullDb, forceFull) {
    var fs = initFs();
    var data = migrate(fullDb || getDb());
    var projects = Array.isArray(data.projects) ? data.projects : [];
    var cases = (data.fsi && Array.isArray(data.fsi.cases)) ? data.fsi.cases : [];
    var meta = data.meta && typeof data.meta === 'object' ? data.meta : {};
    var fsiMeta = (data.fsi && data.fsi.meta && typeof data.fsi.meta === 'object') ? data.fsi.meta : {};

    if (!meta.updatedAt) meta.updatedAt = new Date().toISOString();
    meta.rev = (meta.rev | 0);

    var localP = {};
    var localC = {};
    if (wantsProjects()) {
      projects.forEach(function (p) {
        if (!p || !p.id) return;
        var payload = stripUndefined(Object.assign({}, p, { id: p.id }));
        localP[p.id] = { payload: payload, json: stableJson(payload) };
      });
    }
    if (wantsFsi()) {
      cases.forEach(function (c) {
        if (!c || !c.id) return;
        var payload = stripUndefined(Object.assign({}, c, { id: c.id }));
        localC[c.id] = { payload: payload, json: stableJson(payload) };
      });
    }

    var ops = [];
    var docsChanged = false;

    if (wantsProjects()) {
      Object.keys(localP).forEach(function (id) {
        var entry = localP[id];
        if (!forceFull && lastPushedProjects.get(id) === entry.json) return;
        docsChanged = true;
        ops.push(function (batch) {
          batch.set(fs.collection('projects').doc(id), entry.payload);
        });
      });
      var knownP = new Set();
      lastPushedProjects.forEach(function (_v, id) { knownP.add(id); });
      cacheProjects.forEach(function (_v, id) { knownP.add(id); });
      knownP.forEach(function (id) {
        if (localP[id]) return;
        docsChanged = true;
        ops.push(function (batch) {
          batch.delete(fs.collection('projects').doc(id));
        });
      });
    }

    if (wantsFsi()) {
      Object.keys(localC).forEach(function (id) {
        var entry = localC[id];
        if (!forceFull && lastPushedCases.get(id) === entry.json) return;
        docsChanged = true;
        ops.push(function (batch) {
          batch.set(fs.collection('fsi_cases').doc(id), entry.payload);
        });
      });
      var knownC = new Set();
      lastPushedCases.forEach(function (_v, id) { knownC.add(id); });
      cacheCases.forEach(function (_v, id) { knownC.add(id); });
      knownC.forEach(function (id) {
        if (localC[id]) return;
        docsChanged = true;
        ops.push(function (batch) {
          batch.delete(fs.collection('fsi_cases').doc(id));
        });
      });
    }

    var syncDoc = buildSyncDocForScope(meta, fsiMeta);
    var syncJson = stableJson(syncDoc);
    var syncNeeded = forceFull || docsChanged || syncJson !== lastPushedSyncJson;
    if (syncNeeded) {
      lastLocalWriteAt = syncDoc.updatedAt || '';
      ops.push(function (batch) {
        batch.set(fs.doc('meta/sync'), syncDoc);
      });
    }

    if (!ops.length) {
      setStatus('已同步');
      return true;
    }

    writing = true;
    setStatus('即時同步中');
    try {
      await runBatches(ops);
      markLastPushedFromWrite(localP, localC, syncDoc);
      // Align listener caches optimistically so deletes/diffs stay correct before snapshots.
      if (wantsProjects()) {
        Object.keys(localP).forEach(function (id) {
          cacheProjects.set(id, Object.assign({}, localP[id].payload, { id: id }));
        });
        Array.from(cacheProjects.keys()).forEach(function (id) {
          if (!localP[id]) cacheProjects.delete(id);
        });
      }
      if (wantsFsi()) {
        Object.keys(localC).forEach(function (id) {
          cacheCases.set(id, Object.assign({}, localC[id].payload, { id: id }));
        });
        Array.from(cacheCases.keys()).forEach(function (id) {
          if (!localC[id]) cacheCases.delete(id);
        });
      }
      cacheSync = syncDoc;
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
      writeDb(getDb(), false);
    }, DEBOUNCE_MS);
  }

  async function pushNow() {
    clearTimeout(pushTimer);
    pushTimer = null;
    return writeDb(getDb(), false);
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

  /** Prefetch meta/sync so scoped migration can preserve the other side's meta fields. */
  async function prefetchSyncMeta() {
    try {
      var snap = await initFs().doc('meta/sync').get();
      if (snap.exists) cacheSync = snap.data() || {};
    } catch (err) {
      console.warn('[TS8FirestoreSync] prefetch meta/sync', err);
    }
  }

  async function migrateOnceFromLegacy() {
    setStatus('即時同步中');
    if (scope !== 'all') {
      await prefetchSyncMeta();
    }
    var legacy = await fetchLegacy();
    if (!legacy) legacy = getDb();
    legacy = migrate(legacy);
    var ok = await writeDb(legacy, true);
    if (ok && opts && typeof opts.onRemote === 'function') {
      // Prefer assembled scoped db so the other domain's local data is not blanked.
      var assembled = migrate(assembleDb());
      applyingRemote = true;
      try { opts.onRemote(assembled); } finally { applyingRemote = false; }
    }
    return ok;
  }

  function listen() {
    var fs = initFs();
    unsubs.forEach(function (u) { try { u(); } catch (_) {} });
    unsubs = [];
    // Collections we do not subscribe to are marked ready immediately.
    ready = {
      projects: !wantsProjects(),
      cases: !wantsFsi(),
      sync: false
    };
    if (wantsProjects()) cacheProjects = new Map();
    if (wantsFsi()) cacheCases = new Map();
    cacheSync = null;

    if (wantsProjects()) {
      unsubs.push(fs.collection('projects').onSnapshot(function (snap) {
        cacheProjects = new Map();
        snap.forEach(function (doc) {
          var data = doc.data() || {};
          cacheProjects.set(doc.id, Object.assign({}, data, { id: doc.id }));
        });
        ready.projects = true;
        scheduleEmitRemote();
      }, function (err) {
        console.warn('[TS8FirestoreSync] projects listen', err);
        setStatus('同步失敗');
      }));
    }

    if (wantsFsi()) {
      unsubs.push(fs.collection('fsi_cases').onSnapshot(function (snap) {
        cacheCases = new Map();
        snap.forEach(function (doc) {
          var data = doc.data() || {};
          cacheCases.set(doc.id, Object.assign({}, data, { id: doc.id }));
        });
        ready.cases = true;
        scheduleEmitRemote();
      }, function (err) {
        console.warn('[TS8FirestoreSync] fsi_cases listen', err);
        setStatus('同步失敗');
      }));
    }

    unsubs.push(fs.doc('meta/sync').onSnapshot(function (snap) {
      cacheSync = snap.exists ? (snap.data() || {}) : {};
      ready.sync = true;
      scheduleEmitRemote();
    }, function (err) {
      console.warn('[TS8FirestoreSync] meta/sync listen', err);
      setStatus('同步失敗');
    }));
  }

  async function start(options) {
    opts = options || {};
    scope = normalizeScope(opts.scope);
    if (!enabled()) return { enabled: false, migrated: false, scope: scope };
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
    return { enabled: true, migrated: !!migrated, wasEmpty: empty, scope: scope };
  }

  function stop() {
    clearTimeout(pushTimer);
    pushTimer = null;
    if (remoteRaf != null) { try { cancelAnimationFrame(remoteRaf); } catch (_) {} remoteRaf = null; }
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
    isStarted: function () { return started; },
    getScope: function () { return scope; }
  };
})(typeof window !== 'undefined' ? window : this);
