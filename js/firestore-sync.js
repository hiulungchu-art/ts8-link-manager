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
  /** Deletes are explicit. A doc missing from a local snapshot is not a delete. */
  var explicitDeletes = { projects: new Set(), fsi: new Set() };
  var emitRetry = null;

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

  function statusUnlessPage(text) {
    if (opts && opts.manageStatus) return;
    setStatus(text);
  }

  function emitRemoteIfReady() {
    if (!ready.projects || !ready.cases || !ready.sync) return;
    if (applyingRemote || writing) {
      // The listener cache is already updated. Retry after the write so a
      // snapshot that arrived mid-write is not dropped.
      clearTimeout(emitRetry);
      emitRetry = setTimeout(scheduleEmitRemote, WRITE_SUPPRESS_MS + 40);
      return;
    }
    var at = cacheSync && cacheSync.updatedAt;
    if (at && lastLocalWriteAt && at === lastLocalWriteAt) {
      // Own-write echo: align baseline, skip onRemote to avoid UI churn.
      markLastPushedFromCaches();
      statusUnlessPage('已同步');
      return;
    }
    var assembled = migrate(assembleDb());
    applyingRemote = true;
    try {
      if (opts && typeof opts.onRemote === 'function') opts.onRemote(assembled);
      markLastPushedFromCaches();
      statusUnlessPage('已同步');
    } catch (err) {
      console.warn('[TS8FirestoreSync] onRemote failed', err);
      statusUnlessPage('同步失敗');
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
      explicitDeletes.projects.forEach(function (id) {
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
      explicitDeletes.fsi.forEach(function (id) {
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
      statusUnlessPage('已同步');
      return true;
    }

    writing = true;
    statusUnlessPage('待同步');
    var deletedProjectIds = [];
    var deletedCaseIds = [];
    if (wantsProjects()) {
      explicitDeletes.projects.forEach(function (id) {
        if (!localP[id]) deletedProjectIds.push(id);
      });
    }
    if (wantsFsi()) {
      explicitDeletes.fsi.forEach(function (id) {
        if (!localC[id]) deletedCaseIds.push(id);
      });
    }
    try {
      await runBatches(ops);
      deletedProjectIds.forEach(function (id) { explicitDeletes.projects.delete(id); });
      deletedCaseIds.forEach(function (id) { explicitDeletes.fsi.delete(id); });
      markLastPushedFromWrite(localP, localC, syncDoc);
      // Update docs we wrote. Never drop a cached id just because this
      // snapshot did not include it.
      if (wantsProjects()) {
        Object.keys(localP).forEach(function (id) {
          cacheProjects.set(id, Object.assign({}, localP[id].payload, { id: id }));
        });
        deletedProjectIds.forEach(function (id) {
          cacheProjects.delete(id);
          lastPushedProjects.delete(id);
        });
      }
      if (wantsFsi()) {
        Object.keys(localC).forEach(function (id) {
          cacheCases.set(id, Object.assign({}, localC[id].payload, { id: id }));
        });
        deletedCaseIds.forEach(function (id) {
          cacheCases.delete(id);
          lastPushedCases.delete(id);
        });
      }
      cacheSync = syncDoc;
      statusUnlessPage('已同步');
      return true;
    } catch (err) {
      console.warn('[TS8FirestoreSync] write failed', err);
      statusUnlessPage('同步失敗');
      return false;
    } finally {
      setTimeout(function () { writing = false; }, WRITE_SUPPRESS_MS);
    }
  }

  /**
   * Write only the project/case ops the page queued. Scope still applies:
   * a projects page cannot write fsi_cases, and the reverse.
   * Project docs are merged from the queued ops inside a transaction so a
   * missing id in the local array is never inferred as a delete.
   */
  async function writeExplicit(intent) {
    var fs = initFs();
    intent = intent || {};
    writing = true;
    statusUnlessPage('待同步');
    var written = [];
    var conflicts = [];
    try {
      if (wantsProjects()) {
        var projectDeletes = intent.projectDeletes || [];
        for (var d = 0; d < projectDeletes.length; d++) {
          var deleteId = projectDeletes[d];
          await fs.collection('projects').doc(deleteId).delete();
          cacheProjects.delete(deleteId);
          lastPushedProjects.delete(deleteId);
          explicitDeletes.projects.delete(deleteId);
          written.push({ id: deleteId, deleted: true, collection: 'projects' });
        }
        var projectWrites = intent.projectWrites || [];
        for (var w = 0; w < projectWrites.length; w++) {
          await commitMergedDoc(fs, 'projects', projectWrites[w], conflicts, written);
        }
      }
      if (wantsFsi()) {
        var caseDeletes = intent.caseDeletes || [];
        for (var c = 0; c < caseDeletes.length; c++) {
          var caseId = caseDeletes[c];
          await fs.collection('fsi_cases').doc(caseId).delete();
          cacheCases.delete(caseId);
          lastPushedCases.delete(caseId);
          explicitDeletes.fsi.delete(caseId);
          written.push({ id: caseId, deleted: true, collection: 'fsi' });
        }
        var caseWrites = intent.caseWrites || [];
        for (var k = 0; k < caseWrites.length; k++) {
          await commitMergedDoc(fs, 'fsi_cases', caseWrites[k], conflicts, written);
        }
      }
      var data = getDb() || {};
      var meta = (data.meta && typeof data.meta === 'object') ? data.meta : {};
      if (!meta.updatedAt) meta.updatedAt = new Date().toISOString();
      var fsiMeta = (data.fsi && data.fsi.meta && typeof data.fsi.meta === 'object') ? data.fsi.meta : {};
      var syncDoc = buildSyncDocForScope(meta, fsiMeta);
      lastLocalWriteAt = syncDoc.updatedAt || '';
      await fs.doc('meta/sync').set(syncDoc);
      cacheSync = syncDoc;
      lastPushedSyncJson = stableJson(syncDoc);
      if (conflicts.length && opts && typeof opts.onConflicts === 'function') opts.onConflicts(conflicts);
      return { ok: true, written: written, conflicts: conflicts };
    } catch (err) {
      console.warn('[TS8FirestoreSync] explicit write failed', err);
      statusUnlessPage('同步失敗');
      return { ok: false, error: err, written: written, conflicts: conflicts };
    } finally {
      setTimeout(function () { writing = false; }, WRITE_SUPPRESS_MS);
    }
  }

  async function commitMergedDoc(fs, collectionName, entry, conflicts, written) {
    var ref = fs.collection(collectionName).doc(entry.id);
    var payloadOut = null;
    var deleted = false;
    await fs.runTransaction(function (tx) {
      return tx.get(ref).then(function (snap) {
        var server = snap && snap.exists ? Object.assign({ id: entry.id }, snap.data() || {}) : null;
        var mergedDoc = entry.local || null;
        var mergedConflicts = [];
        if (collectionName === 'projects' && opts && typeof opts.mergeProject === 'function') {
          var merged = opts.mergeProject({ id: entry.id, server: server, local: entry.local, ops: entry.ops || [] });
          mergedDoc = merged && Object.prototype.hasOwnProperty.call(merged, 'doc') ? merged.doc : merged;
          mergedConflicts = (merged && merged.conflicts) || [];
        } else if (collectionName === 'fsi_cases' && opts && typeof opts.mergeCase === 'function') {
          var mergedCase = opts.mergeCase({ id: entry.id, server: server, local: entry.local, ops: entry.ops || [] });
          mergedDoc = mergedCase && Object.prototype.hasOwnProperty.call(mergedCase, 'doc') ? mergedCase.doc : mergedCase;
          mergedConflicts = (mergedCase && mergedCase.conflicts) || [];
        }
        mergedConflicts.forEach(function (item) { conflicts.push(item); });
        if (!mergedDoc) {
          tx.delete(ref);
          deleted = true;
          return;
        }
        payloadOut = stripUndefined(Object.assign({}, mergedDoc, { id: entry.id }));
        tx.set(ref, payloadOut);
      });
    });
    var cache = collectionName === 'projects' ? cacheProjects : cacheCases;
    var pushed = collectionName === 'projects' ? lastPushedProjects : lastPushedCases;
    if (deleted || !payloadOut) {
      cache.delete(entry.id);
      pushed.delete(entry.id);
      written.push({ id: entry.id, deleted: true, collection: collectionName === 'projects' ? 'projects' : 'fsi' });
      return;
    }
    var stored = Object.assign({}, payloadOut, { id: entry.id });
    cache.set(entry.id, stored);
    pushed.set(entry.id, stableJson(stored));
    written.push({ id: entry.id, doc: stored, collection: collectionName === 'projects' ? 'projects' : 'fsi' });
  }

  function noteDelete(kind, id) {
    if (!id) return;
    if (kind === 'projects' || kind === 'fsi') explicitDeletes[kind].add(String(id));
  }

  function noteKeep(kind, id) {
    if (!id) return;
    if (kind === 'projects' || kind === 'fsi') explicitDeletes[kind].delete(String(id));
  }

  function schedulePush() {
    if (!enabled() || !started) return;
    statusUnlessPage('待同步');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      if (opts && typeof opts.flushLocal === 'function') {
        Promise.resolve(opts.flushLocal()).catch(function (err) {
          console.warn('[TS8FirestoreSync] flushLocal failed', err);
        });
        return;
      }
      writeDb(getDb(), false);
    }, DEBOUNCE_MS);
  }

  async function pushNow() {
    clearTimeout(pushTimer);
    pushTimer = null;
    if (opts && typeof opts.flushLocal === 'function') return opts.flushLocal();
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
    statusUnlessPage('待同步');
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
    statusUnlessPage('待同步');
    var empty = await isEmpty();
    var migrated = false;
    if (empty && (!opts || opts.allowEmptySeed !== false)) {
      migrated = await migrateOnceFromLegacy();
    }
    listen();
    started = true;
    if (!empty) statusUnlessPage('待同步');
    return { enabled: true, migrated: !!migrated, wasEmpty: empty, scope: scope };
  }

  function stop() {
    clearTimeout(pushTimer);
    pushTimer = null;
    clearTimeout(emitRetry);
    emitRetry = null;
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
    writeDb: writeDb,
    writeExplicit: writeExplicit,
    noteDelete: noteDelete,
    noteKeep: noteKeep,
    isStarted: function () { return started; },
    getScope: function () { return scope; }
  };
})(typeof window !== 'undefined' ? window : this);
