import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const merge = require('../js/sync-merge.js');

function bootSync() {
  const store = new Map();
  const log = [];
  function pathOf(ref) {
    return ref.path || ((ref.collection || '') + '/' + (ref.id || ''));
  }
  function apply(op, ref, val) {
    const path = pathOf(ref);
    log.push({ op: op, path: path });
    if (op === 'delete') store.delete(path);
    else store.set(path, val);
  }
  function collectionRef(name) {
    return {
      doc(id) {
        return { collection: name, id: id, path: name + '/' + id };
      },
      limit() {
        return {
          get: async () => ({ empty: !Array.from(store.keys()).some((key) => key.startsWith(name + '/')) })
        };
      },
      onSnapshot(onNext) {
        const prefix = name + '/';
        onNext({
          forEach(fn) {
            Array.from(store.keys()).filter((key) => key.startsWith(prefix)).forEach((key) => {
              fn({ id: key.slice(prefix.length), data: () => store.get(key) });
            });
          }
        });
        return function () {};
      }
    };
  }
  const firestore = {
    collection: collectionRef,
    doc(path) {
      return {
        path: path,
        get: async () => ({ exists: store.has(path), data: () => store.get(path) }),
        set: async (val) => { apply('set', { path: path }, val); },
        onSnapshot(onNext) {
          onNext({ exists: store.has(path), data: () => store.get(path) || {} });
          return function () {};
        }
      };
    },
    batch() {
      const ops = [];
      return {
        set(ref, val) { ops.push({ op: 'set', ref: ref, val: val }); },
        delete(ref) { ops.push({ op: 'delete', ref: ref }); },
        commit: async () => { ops.forEach((item) => apply(item.op, item.ref, item.val)); }
      };
    },
    runTransaction(fn) {
      const tx = {
        get(ref) {
          return Promise.resolve({ exists: store.has(pathOf(ref)), data: () => store.get(pathOf(ref)) });
        },
        set(ref, val) { tx._ops.push({ op: 'set', ref: ref, val: val }); },
        delete(ref) { tx._ops.push({ op: 'delete', ref: ref }); },
        _ops: []
      };
      return Promise.resolve(fn(tx)).then(() => {
        tx._ops.forEach((item) => apply(item.op, item.ref, item.val));
      });
    }
  };
  const statuses = [];
  const context = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    Map: Map,
    Set: Set,
    Promise: Promise,
    Date: Date,
    JSON: JSON,
    Object: Object,
    Array: Array,
    String: String,
    Error: Error,
    TS8_CONFIG: { FIREBASE: { apiKey: 'test', projectId: 'ts8-link-manager' } },
    firebase: {
      apps: [],
      initializeApp() { this.apps.push({}); },
      firestore() { return firestore; }
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL('../js/firestore-sync.js', import.meta.url), 'utf8'), context);
  return {
    api: context.TS8FirestoreSync,
    store: store,
    log: log,
    statuses: statuses,
    paths() { return log.map((item) => item.op + ' ' + item.path); }
  };
}

function project(id, note) {
  return {
    id: id,
    name: '項目 ' + id,
    code: '',
    jobNo: 'J',
    pm: '',
    notes: note || '',
    createdAt: '2026-09-01',
    partAs: [{ id: 'pa', label: 'Part A', eformId: '', docNo: '', status: '草稿', notes: '', links: [], days: [] }]
  };
}

test('projects scope does not write FSI and does not delete a missing project', async () => {
  const env = bootSync();
  env.store.set('projects/p1', project('p1'));
  env.store.set('projects/p2', project('p2', '別人的項目'));
  env.store.set('fsi_cases/c1', { id: 'c1', ref: 'FSI-1', notes: '原註' });
  let db = {
    projects: [project('p1', '只改 p1')],
    meta: { updatedAt: '2026-11-23T01:00:00.000Z', rev: 2 },
    fsi: { cases: [{ id: 'c1', ref: 'FSI-1', notes: '不應寫入' }], meta: { updatedAt: '2026-11-23T01:00:00.000Z' } }
  };
  await env.api.start({
    scope: 'projects',
    allowEmptySeed: false,
    getDb: () => db,
    setStatus: (text) => env.statuses.push(text),
    manageStatus: true
  });
  env.log.length = 0;
  const ok = await env.api.writeDb(db, false);
  assert.equal(ok, true);
  const paths = env.paths();
  assert.ok(paths.some((line) => line.startsWith('set projects/p1')));
  assert.equal(paths.some((line) => line.includes('fsi_cases')), false);
  assert.equal(paths.some((line) => line.includes('projects/p2')), false);
  assert.equal(env.store.get('projects/p2').notes, '別人的項目');
  assert.equal(env.store.get('fsi_cases/c1').notes, '原註');
  assert.equal(env.statuses.includes('已同步'), false);

  db = {
    projects: [],
    meta: { updatedAt: '2026-11-23T02:00:00.000Z', rev: 3 },
    fsi: { cases: [], meta: {} }
  };
  env.api.noteDelete('fsi', 'c1');
  env.api.noteDelete('projects', 'p1');
  env.log.length = 0;
  await env.api.writeDb(db, false);
  const afterDelete = env.paths();
  assert.ok(afterDelete.some((line) => line === 'delete projects/p1'));
  assert.equal(afterDelete.some((line) => line.includes('fsi_cases')), false);
  assert.ok(env.store.has('fsi_cases/c1'));
  assert.ok(env.store.has('projects/p2'));
});

test('explicit project merge keeps the other day and ignores FSI writes on the TS8 scope', async () => {
  const env = bootSync();
  const original = project('p1');
  original.partAs[0].days = [
    { id: 'd1', date: '2026-09-09', label: '隔離日', partBSubmissionId: '', status: '未開始', notes: '', links: [] },
    { id: 'd2', date: '2026-09-10', label: '隔離日', partBSubmissionId: '', status: '未開始', notes: '遠端', links: [] }
  ];
  env.store.set('projects/p1', original);
  env.store.set('fsi_cases/c1', { id: 'c1', ref: 'KEEP', notes: 'fsi' });
  const base = merge.clone(original);
  base.partAs[0].days[1].notes = '';
  const local = merge.clone(base);
  local.partAs[0].days[0].notes = '本地 d1';
  const ops = merge.diffProjects([base], [local]);
  let seen = [];
  await env.api.start({
    scope: 'projects',
    allowEmptySeed: false,
    manageStatus: true,
    getDb: () => ({ projects: [local], meta: { updatedAt: '2026-11-23T03:00:00.000Z', rev: 4 }, fsi: { cases: [], meta: {} } }),
    setStatus: (text) => seen.push(text),
    mergeProject({ id, server, ops: queued }) {
      const applied = merge.applyOps(server ? [server] : [], queued);
      return {
        doc: applied.projects.find((item) => item.id === id) || null,
        conflicts: applied.conflicts
      };
    }
  });
  env.log.length = 0;
  const result = await env.api.writeExplicit({
    projectWrites: [{ id: 'p1', local: local, ops: ops }],
    projectDeletes: [],
    caseWrites: [{ id: 'c1', local: { id: 'c1', ref: 'KEEP', notes: '被改' } }],
    caseDeletes: ['c1']
  });
  assert.equal(result.ok, true);
  const saved = env.store.get('projects/p1');
  assert.equal(saved.partAs[0].days.find((day) => day.id === 'd1').notes, '本地 d1');
  assert.equal(saved.partAs[0].days.find((day) => day.id === 'd2').notes, '遠端');
  assert.equal(env.store.get('fsi_cases/c1').notes, 'fsi');
  assert.equal(env.paths().some((line) => line.includes('fsi_cases')), false);
  assert.equal(seen.includes('已同步'), false);
});

test('fsi scope does not write projects', async () => {
  const env = bootSync();
  env.store.set('projects/p1', project('p1', 'ts8'));
  env.store.set('fsi_cases/c1', { id: 'c1', ref: 'A', notes: '' });
  const db = {
    projects: [project('p1', '不應寫入 TS8')],
    meta: { updatedAt: '2026-11-23T04:00:00.000Z', rev: 1 },
    fsi: { cases: [{ id: 'c1', ref: 'A', notes: 'FSI 更新' }], meta: { updatedAt: '2026-11-23T04:00:00.000Z' } }
  };
  await env.api.start({
    scope: 'fsi',
    allowEmptySeed: false,
    getDb: () => db,
    setStatus: () => {}
  });
  env.log.length = 0;
  env.api.noteDelete('projects', 'p1');
  await env.api.writeDb(db, false);
  const paths = env.paths();
  assert.ok(paths.some((line) => line.startsWith('set fsi_cases/c1')));
  assert.equal(paths.some((line) => line.includes('projects/')), false);
  assert.equal(env.store.get('projects/p1').notes, 'ts8');
});

test('a failed explicit write is not reported as synced', async () => {
  const env = bootSync();
  const statuses = [];
  await env.api.start({
    scope: 'projects',
    allowEmptySeed: false,
    getDb: () => ({ projects: [], meta: { updatedAt: '2026-11-23T05:00:00.000Z', rev: 1 }, fsi: { cases: [], meta: {} } }),
    setStatus: (text) => statuses.push(text),
    mergeProject() { throw new Error('server down'); }
  });
  const result = await env.api.writeExplicit({
    projectWrites: [{ id: 'p1', local: project('p1'), ops: [{ kind: 'project-create', projectId: 'p1', project: project('p1') }] }]
  });
  assert.equal(result.ok, false);
  assert.ok(statuses.includes('同步失敗'));
  assert.equal(statuses.includes('已同步'), false);
});
