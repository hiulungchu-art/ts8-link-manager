import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const merge = require('../js/sync-merge.js');
const guards = require('../js/ts8-guards.js');
const access = require('../js/access.js');

function project(id, days) {
  return {
    id: id,
    name: '項目 ' + id,
    code: '',
    jobNo: 'J1',
    pm: 'PM',
    notes: '',
    createdAt: '2026-09-01',
    partAs: [{
      id: 'pa-1',
      label: 'Part A #1',
      eformId: '',
      docNo: 'DOC',
      status: '草稿',
      notes: '',
      links: [],
      days: days
    }]
  };
}

function day(id, date, extra) {
  return Object.assign({
    id: id,
    date: date,
    label: '隔離日',
    partBSubmissionId: '',
    status: '未開始',
    notes: '',
    links: [
      { id: id + '-b1', type: 'b1', label: 'B1', url: 'https://example.com/' + id, notes: '', driveFileId: '', sourceEmailId: '' }
    ]
  }, extra || {});
}

function memoryServer(initial) {
  const docs = new Map();
  (initial || []).forEach((item) => docs.set(item.id, merge.clone(item)));
  return {
    read(id) { return docs.has(id) ? merge.clone(docs.get(id)) : null; },
    all() { return Array.from(docs.values()).map((item) => merge.clone(item)); },
    writeMerged(id, ops) {
      const server = docs.has(id) ? merge.clone(docs.get(id)) : null;
      const applied = merge.applyOps(server ? [server] : [], ops);
      const doc = applied.projects.find((item) => item.id === id) || null;
      if (!doc) docs.delete(id);
      else docs.set(id, doc);
      return applied;
    }
  };
}

function sessionWith(projects) {
  let current = merge.clone(projects);
  const session = merge.createSyncSession({
    getProjects: () => current,
    setProjects: (next) => { current = next; }
  });
  session.restore({ seq: 1, ops: [], established: true });
  return {
    session,
    get current() { return current; },
    set current(value) { current = value; },
    edit(mutator) {
      current = merge.clone(current);
      mutator(current);
      session.capture();
    }
  };
}

test('sync label is 已同步 only after confirmation with nothing pending', () => {
  assert.equal(merge.syncLabel({ transport: 'firestore', confirmed: true, pending: false, failed: false }), '已同步');
  assert.equal(merge.syncLabel({ transport: 'firestore', confirmed: true, pending: true }), '待同步');
  assert.equal(merge.syncLabel({ transport: 'local', confirmed: false, pending: false }), '已儲存於此裝置');
  assert.equal(merge.syncLabel({ transport: 'local', pending: true }), '待同步');
  assert.equal(merge.syncLabel({ failed: true, pending: true, transport: 'firestore', confirmed: true }), '同步失敗');
  assert.equal(merge.syncLabel({ transport: 'firestore', confirmed: false, pending: false }), '已儲存於此裝置');
});

test('queued edits replay in order and survive a reload', () => {
  const base = [project('p1', [day('d1', '2026-09-09')])];
  const client = sessionWith(base);
  client.edit((projects) => { projects[0].partAs[0].days[0].status = 'B1進行中'; });
  client.edit((projects) => { projects[0].partAs[0].days[0].status = '已完結'; });
  const saved = client.session.snapshot();
  assert.equal(saved.ops.length, 2);
  assert.deepEqual(saved.ops.map((op) => op.fields.status), ['B1進行中', '已完結']);

  let restoredProjects = merge.clone(client.current);
  const restored = merge.createSyncSession({
    getProjects: () => restoredProjects,
    setProjects: (next) => { restoredProjects = next; }
  });
  restored.restore(saved);
  const server = memoryServer(base);
  const intent = restored.buildWrites();
  const applied = server.writeMerged('p1', intent.projectWrites[0].ops);
  assert.equal(server.read('p1').partAs[0].days[0].status, '已完結');
  assert.equal(applied.conflicts.length, 0);
  restored.acknowledge(intent.sentSeq, [{ id: 'p1', doc: server.read('p1') }]);
  assert.equal(restored.pending(), false);
});

test('two clients editing different days and a delete do not clobber each other', () => {
  const base = [project('p1', [
    day('d1', '2026-09-09'),
    day('d2', '2026-09-10'),
    day('d3', '2026-09-11')
  ])];
  const server = memoryServer(base);
  const a = sessionWith(base);
  const b = sessionWith(base);
  a.edit((projects) => { projects[0].partAs[0].days[0].notes = '甲改隔離日一'; });
  b.edit((projects) => { projects[0].partAs[0].days[1].notes = '乙改隔離日二'; });
  b.edit((projects) => {
    projects[0].partAs[0].days = projects[0].partAs[0].days.filter((item) => item.id !== 'd3');
  });

  const intentA = a.session.buildWrites();
  server.writeMerged('p1', intentA.projectWrites[0].ops);
  const intentB = b.session.buildWrites();
  server.writeMerged('p1', intentB.projectWrites[0].ops);
  const stored = server.read('p1');
  assert.equal(stored.partAs[0].days.find((item) => item.id === 'd1').notes, '甲改隔離日一');
  assert.equal(stored.partAs[0].days.find((item) => item.id === 'd2').notes, '乙改隔離日二');
  assert.equal(stored.partAs[0].days.find((item) => item.id === 'd3'), undefined);

  const stale = sessionWith([project('p1', [day('d1', '2026-09-09')])]);
  stale.session.restore({ seq: 1, ops: [], established: true });
  assert.equal(stale.session.buildWrites().projectWrites.length, 0);
  assert.equal(server.all().length, 1);
});

test('a project missing from a local snapshot is not a delete', () => {
  const server = memoryServer([
    project('p1', [day('d1', '2026-09-09')]),
    project('p2', [day('d2', '2026-09-10')])
  ]);
  const localOnlyP1 = [project('p1', [day('d1', '2026-09-09', { notes: '只改 p1' })])];
  const client = sessionWith([project('p1', [day('d1', '2026-09-09')])]);
  client.current = merge.clone(localOnlyP1);
  client.session.capture();
  const intent = client.session.buildWrites();
  assert.equal(intent.projectWrites.length, 1);
  assert.equal(intent.projectWrites[0].id, 'p1');
  assert.equal(intent.projectDeletes.length, 0);
  server.writeMerged('p1', intent.projectWrites[0].ops);
  assert.ok(server.read('p2'));
  assert.equal(server.read('p1').partAs[0].days[0].notes, '只改 p1');
});

test('same-field conflict keeps the unsent local value', () => {
  const base = [project('p1', [day('d1', '2026-09-09')])];
  const server = memoryServer(base);
  server.writeMerged('p1', merge.diffProjects(base, [project('p1', [day('d1', '2026-09-09', { status: 'B2進行中' })])]));
  const client = sessionWith(base);
  client.edit((projects) => { projects[0].partAs[0].days[0].status = '已完結'; });
  const intent = client.session.buildWrites();
  const applied = server.writeMerged('p1', intent.projectWrites[0].ops);
  assert.equal(server.read('p1').partAs[0].days[0].status, '已完結');
  assert.ok(applied.conflicts.some((item) => item.field === 'status' && item.local === '已完結'));
});

test('remote snapshot keeps unsent local edits and server-only records', () => {
  const base = [project('p1', [day('d1', '2026-09-09'), day('d2', '2026-09-10')])];
  const client = sessionWith(base);
  client.edit((projects) => { projects[0].partAs[0].days[0].partBSubmissionId = 'PB-LOCAL'; });
  const server = [
    project('p1', [day('d1', '2026-09-09', { notes: '遠端備註' }), day('d2', '2026-09-10')]),
    project('p2', [day('d9', '2026-09-12')])
  ];
  const accepted = client.session.acceptRemote(server, '2026-11-23T00:00:00.000Z', '2026-11-23T00:00:00.000Z');
  const p1 = accepted.projects.find((item) => item.id === 'p1');
  assert.equal(p1.partAs[0].days[0].partBSubmissionId, 'PB-LOCAL');
  assert.equal(p1.partAs[0].days[0].notes, '遠端備註');
  assert.ok(accepted.projects.find((item) => item.id === 'p2'));
  assert.equal(client.session.pending(), true);
});

test('unknown baseline does not delete server-only projects', () => {
  let projects = [project('p1', [day('d1', '2026-09-09', { notes: '舊本機' })])];
  const session = merge.createSyncSession({
    getProjects: () => projects,
    setProjects: (next) => { projects = next; }
  });
  session.restore(null);
  const server = [project('p1', [day('d1', '2026-09-09')]), project('p2', [day('d2', '2026-09-10')])];
  const accepted = session.acceptRemote(server, '2026-11-01T00:00:00.000Z', '2026-11-23T00:00:00.000Z');
  assert.ok(accepted.projects.find((item) => item.id === 'p2'));
  assert.equal(accepted.projects.find((item) => item.id === 'p1').partAs[0].days[0].notes, '舊本機');
  assert.equal(session.pending(), true);
  assert.equal(session.buildWrites().projectDeletes.length, 0);
  assert.ok(!session.ops().some((op) => String(op.kind).includes('delete') && op.projectId === 'p2'));
});

test('flat records merge keeps independent cases and explicit deletes', () => {
  const base = [{ id: 'c1', ref: 'A', notes: '' }, { id: 'c2', ref: 'B', notes: '' }];
  const local = [{ id: 'c1', ref: 'A', notes: '本地' }];
  const server = [{ id: 'c1', ref: 'A', notes: '' }, { id: 'c2', ref: 'B', notes: '遠端' }, { id: 'c3', ref: 'C', notes: '新' }];
  const merged = merge.mergeRecords(base, local, server);
  assert.equal(merged.records.find((item) => item.id === 'c1').notes, '本地');
  assert.equal(merged.records.find((item) => item.id === 'c2'), undefined);
  assert.ok(merged.records.find((item) => item.id === 'c3'));
});

test('pdf validation rejects multi-file, type, and size before a caller would upload', () => {
  const two = guards.validatePdfFiles([
    { name: 'a.pdf', type: 'application/pdf', size: 10 },
    { name: 'b.pdf', type: 'application/pdf', size: 10 }
  ]);
  assert.equal(two.ok, false);
  assert.equal(two.code, 'multi');
  const png = guards.validatePdfFiles([{ name: 'a.png', type: 'image/png', size: 10 }]);
  assert.equal(png.ok, false);
  assert.equal(png.code, 'type');
  const big = guards.validatePdfFiles([{ name: 'a.pdf', type: 'application/pdf', size: guards.PDF_MAX_BYTES + 1 }]);
  assert.equal(big.ok, false);
  assert.equal(big.code, 'size');
  const ok = guards.validatePdfFiles([{ name: 'a.PDF', type: '', size: 20 }]);
  assert.equal(ok.ok, true);
});

test('url scheme allows only http and https', () => {
  assert.equal(guards.safeHttpUrl('https://drive.google.com/file/d/abc/view').startsWith('https://'), true);
  assert.equal(guards.safeHttpUrl('http://example.com/a'), 'http://example.com/a');
  assert.equal(guards.safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(guards.safeHttpUrl('data:text/html,hi'), '');
  assert.equal(guards.safeHttpUrl('/relative'), '');
  assert.equal(guards.safeHttpUrl(''), '');
});

test('Hong Kong parts cross the UTC date boundary', () => {
  const parts = guards.hkParts(new Date('2025-12-31T18:00:00.000Z'));
  assert.equal(parts.ym, '2026-01');
  assert.equal(parts.year, '2026');
  assert.equal(parts.day, '01');
});

test('upload permission fails closed without a verified session', async () => {
  const previousSession = globalThis.TS8_TEST_SESSION;
  const previousCfg = globalThis.TS8_CONFIG;
  globalThis.TS8_CONFIG = { REQUIRE_AUTH: false, EDITOR_EMAILS: ['synthetic@example.com'] };
  globalThis.TS8_TEST_SESSION = null;
  await assert.rejects(() => access.assertUploadAllowed(), (err) => err.code === 'auth');
  globalThis.TS8_TEST_SESSION = { email: 'other@example.com', emailVerified: true, getIdToken: async () => 'tok' };
  await assert.rejects(() => access.assertUploadAllowed(), (err) => err.code === 'auth');
  globalThis.TS8_TEST_SESSION = { email: 'synthetic@example.com', emailVerified: true, getIdToken: async () => 'tok' };
  const allowed = await access.assertUploadAllowed();
  assert.equal(allowed.idToken, 'tok');
  globalThis.TS8_CONFIG.REQUIRE_AUTH = true;
  globalThis.TS8_TEST_SESSION = null;
  assert.equal(access.canReadWorkData(), false);
  globalThis.TS8_TEST_SESSION = previousSession;
  globalThis.TS8_CONFIG = previousCfg;
});
