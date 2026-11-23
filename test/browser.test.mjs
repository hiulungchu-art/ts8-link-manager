import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/home/ubuntu/.npm/_npx/e41f203b7505f1fb/node_modules/playwright'));
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

const FAKE = `
(function(){
  if (window.firebase && window.firebase.firestore) return;
  function ref(path){
    return {
      path: path,
      get: function(){
        return window.__ts8Store({type:'get', path:path}).then(function(data){
          return { exists: data != null, data: function(){ return data; } };
        });
      },
      set: function(val){ return window.__ts8Store({type:'commit', ops:[{op:'set', path:path, val:val}]}); },
      delete: function(){ return window.__ts8Store({type:'commit', ops:[{op:'delete', path:path}]}); },
      onSnapshot: function(next){
        var last = '';
        var timer = setInterval(function(){
          window.__ts8Store({type:'get', path:path}).then(function(data){
            var json = JSON.stringify(data);
            if (json === last) return;
            last = json;
            next({ exists: data != null, data: function(){ return data || {}; } });
          });
        }, 200);
        return function(){ clearInterval(timer); };
      }
    };
  }
  function collection(name){
    return {
      doc: function(id){ return ref(name + '/' + id); },
      limit: function(){
        return { get: function(){
          return window.__ts8Store({type:'list', prefix:name + '/'}).then(function(items){
            return { empty: !items.length };
          });
        } };
      },
      onSnapshot: function(next){
        var last = '';
        var timer = setInterval(function(){
          window.__ts8Store({type:'list', prefix:name + '/'}).then(function(items){
            var json = JSON.stringify(items);
            if (json === last) return;
            last = json;
            next({ forEach: function(fn){
              items.forEach(function(item){
                fn({ id: item.id, data: function(){ return item.data; } });
              });
            } });
          });
        }, 200);
        return function(){ clearInterval(timer); };
      }
    };
  }
  var fsApi = {
    collection: collection,
    doc: ref,
    batch: function(){
      var ops = [];
      return {
        set: function(r, val){ ops.push({op:'set', path:r.path, val:val}); },
        delete: function(r){ ops.push({op:'delete', path:r.path}); },
        commit: function(){ return window.__ts8Store({type:'commit', ops:ops}); }
      };
    },
    runTransaction: function(fn){
      var ops = [];
      return window.__ts8Store({type:'lock'}).then(function(){
        var tx = {
          get: function(r){
            return window.__ts8Store({type:'get', path:r.path}).then(function(data){
              return { exists: data != null, data: function(){ return data; } };
            });
          },
          set: function(r, val){ ops.push({op:'set', path:r.path, val:val}); },
          delete: function(r){ ops.push({op:'delete', path:r.path}); }
        };
        return Promise.resolve(fn(tx)).then(function(){
          return window.__ts8Store({type:'commit', ops:ops});
        });
      }).finally(function(){ return window.__ts8Store({type:'unlock'}); });
    }
  };
  window.firebase = {
    apps: [],
    initializeApp: function(){ this.apps.push({}); },
    firestore: function(){ return fsApi; },
    auth: function(){
      return {
        currentUser: null,
        GoogleAuthProvider: function(){},
        signInWithPopup: function(){ return Promise.reject(new Error('synthetic')); }
      };
    }
  };
  window.firebase.auth.GoogleAuthProvider = function(){};
})();
`;

function listen() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function project(id, name, extra) {
  extra = extra || {};
  const day = extra.day || {};
  return {
    id: id,
    name: name,
    code: extra.code || '',
    jobNo: extra.jobNo || ('JOB-' + id),
    pm: '',
    notes: extra.notes || '',
    createdAt: '2026-09-01',
    partAs: [{
      id: 'pa-' + id,
      label: 'Part A 文件',
      eformId: '',
      docNo: 'DOC-' + id,
      status: '草稿',
      notes: '',
      links: extra.partLinks || [],
      days: [{
        id: 'd-' + id,
        date: day.date || '2026-09-09',
        label: '隔離日',
        partBSubmissionId: day.partB || ('PB-' + id + '-LONG-SUBMISSION-ID-1234567890'),
        status: day.status || '未開始',
        notes: day.notes || '',
        links: day.links || [{
          id: 'b1-' + id,
          type: 'b1',
          label: 'B1',
          url: 'https://example.com/b1/' + id,
          notes: '',
          driveFileId: '',
          sourceEmailId: ''
        }]
      }]
    }]
  };
}

function createStore(seed) {
  const store = new Map(seed || []);
  const log = [];
  let hold = null;
  let failWrites = false;
  let locked = Promise.resolve();
  const releases = [];
  async function handle(msg) {
    if (msg.type === 'lock') {
      if (hold) await hold;
      const prev = locked;
      let release;
      locked = new Promise((resolve) => { release = resolve; });
      releases.push(release);
      await prev;
      return true;
    }
    if (msg.type === 'unlock') {
      const release = releases.shift();
      if (release) release();
      return true;
    }
    if (msg.type === 'get') return store.has(msg.path) ? store.get(msg.path) : null;
    if (msg.type === 'list') {
      const out = [];
      for (const [key, value] of store) {
        if (key.startsWith(msg.prefix)) out.push({ id: key.slice(msg.prefix.length), data: value });
      }
      return out;
    }
    if (msg.type === 'commit') {
      if (failWrites) throw new Error('offline');
      (msg.ops || []).forEach((op) => {
        log.push(op.op + ' ' + op.path);
        if (op.op === 'delete') store.delete(op.path);
        else store.set(op.path, JSON.parse(JSON.stringify(op.val)));
      });
      return true;
    }
    return null;
  }
  return {
    store: store,
    log: log,
    handle: handle,
    pause() {
      let go;
      hold = new Promise((resolve) => { go = resolve; });
      return () => { hold = null; go(); };
    },
    setFailWrites(value) { failWrites = value; }
  };
}

const server = await listen();
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});

after(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
});

function hkYm(date) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit' })
    .formatToParts(date)
    .forEach((part) => { if (part.type !== 'literal') parts[part.type] = part.value; });
  return parts.year + '-' + parts.month;
}

async function blockProduction(context, options) {
  const hits = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (/firebasejs|googleapis\.com|identitytoolkit|securetoken|firebaseio\.com|script\.google\.com/.test(url)) {
      hits.push(url);
      if (options && options.fakeFirebase && /firebasejs/.test(url)) {
        return route.fulfill({ contentType: 'text/javascript', body: FAKE });
      }
      return route.abort();
    }
    return route.continue();
  });
  return hits;
}

async function openPage(context, url, init) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  if (init) await page.addInitScript(init.script, init.arg);
  await page.goto(base + url, { waitUntil: 'domcontentloaded' });
  return { page: page, errors: errors };
}

test('homepage keeps exactly three public entries', async () => {
  const context = await browser.newContext();
  try {
    await blockProduction(context);
    const { page, errors } = await openPage(context, '/index.html');
    const titles = await page.locator('.page-card h2').allTextContents();
    assert.deepEqual(titles, ['TS8 連結管理', '校園 Map', 'TS8 PDF File']);
    const nav = await page.locator('.site-nav-links a').allTextContents();
    assert.deepEqual(nav, ['首頁', 'TS8 連結管理', 'Map']);
    const html = await page.content();
    assert.equal(html.includes('FSI'), false);
    assert.equal(html.includes('Door'), false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('desktop shell scrolls internally and keeps the cream and sage background', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await blockProduction(context);
    const projects = [];
    for (let i = 0; i < 12; i++) {
      const days = [];
      for (let d = 0; d < 18; d++) {
        days.push({
          id: 'd' + i + '-' + d,
          date: '2026-09-' + String(d + 1).padStart(2, '0'),
          label: '隔離日',
          partBSubmissionId: 'PB-VERY-LONG-IDENTIFIER-' + i + '-' + d + '-ABCDEFGHIJKLMNOP',
          status: '未開始',
          notes: '',
          links: []
        });
      }
      projects.push({
        id: 'p' + i,
        name: '很長的項目名稱 '.repeat(6) + i,
        code: 'CODE',
        jobNo: 'J26159-' + i,
        pm: '',
        notes: '',
        createdAt: '2026-09-01',
        partAs: [{ id: 'pa' + i, label: 'Part A', eformId: '', docNo: '', status: '草稿', notes: '', links: [], days: days }]
      });
    }
    const { page } = await openPage(context, '/ts8.html', {
      script: (db) => localStorage.setItem('ts8_project_link_manager_v6', JSON.stringify(db)),
      arg: { projects: projects, meta: { updatedAt: '', rev: 0 }, fsi: { cases: [], meta: {} } }
    });
    await page.waitForSelector('.proj-item');
    const metrics = await page.evaluate(() => {
      const side = document.querySelector('.sidebar');
      const content = document.getElementById('content');
      const card = document.querySelector('.day-card');
      return {
        bodyOverflow: getComputedStyle(document.body).overflow,
        background: getComputedStyle(document.body).backgroundImage,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        listCanScroll: document.querySelector('.proj-list').scrollHeight > document.querySelector('.proj-list').clientHeight + 8,
        contentCanScroll: content.scrollHeight > content.clientHeight + 8,
        pickerDisplay: getComputedStyle(document.getElementById('projPickerToggle')).display,
        noise: !!document.querySelector('feTurbulence'),
        cardVisibility: card ? getComputedStyle(card).contentVisibility : ''
      };
    });
    assert.equal(metrics.bodyOverflow, 'hidden');
    assert.match(metrics.background, /gradient/);
    assert.ok(metrics.pageOverflow <= 1);
    assert.equal(metrics.listCanScroll, true);
    assert.equal(metrics.contentCanScroll, true);
    assert.equal(metrics.pickerDisplay, 'none');
    assert.equal(metrics.noise, false);
    assert.notEqual(metrics.cardVisibility, 'auto');
    const before = await page.locator('.proj-list').evaluate((el) => el.scrollTop);
    await page.locator('.proj-list').evaluate((el) => { el.scrollTop = 240; });
    const after = await page.locator('.proj-list').evaluate((el) => el.scrollTop);
    assert.ok(after > before);
  } finally {
    await context.close();
  }
});

test('mobile widths keep the project picker and avoid horizontal overflow', async () => {
  for (const width of [320, 390, 768]) {
    const context = await browser.newContext({ viewport: { width: width, height: 800 } });
    try {
      await blockProduction(context);
      const projects = [1, 2, 3].map((n) => project('p' + n, '超長項目名稱-'.repeat(8) + n, {
        day: { partB: 'PB-' + 'X'.repeat(48) + n }
      }));
      const { page } = await openPage(context, '/ts8.html', {
        script: (db) => localStorage.setItem('ts8_project_link_manager_v6', JSON.stringify(db)),
        arg: { projects: projects, meta: {}, fsi: { cases: [], meta: {} } }
      });
      await page.waitForSelector('#projPickerName');
      const before = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        listHidden: getComputedStyle(document.getElementById('projList')).display === 'none',
        name: document.getElementById('projPickerName').textContent
      }));
      assert.ok(before.overflow <= 1, 'overflow at ' + width + ': ' + before.overflow);
      assert.equal(before.listHidden, true);
      assert.match(before.name, /超長項目名稱/);
      await page.click('#projPickerToggle');
      await page.waitForSelector('.proj-item');
      await page.locator('.proj-item').nth(1).click();
      const after = await page.evaluate(() => getComputedStyle(document.getElementById('projList')).display === 'none');
      assert.equal(after, true);
    } finally {
      await context.close();
    }
  }
});

test('search, isolation filter, and keyboard dialogs', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    await blockProduction(context);
    const db = {
      projects: [
        project('p1', '項目甲', { day: { partB: 'PB-FIND-ME-7788', notes: '' } }),
        project('p2', '項目乙', { day: { partB: 'PB-OTHER' } })
      ],
      meta: {},
      fsi: { cases: [], meta: {} }
    };
    const { page, errors } = await openPage(context, '/ts8.html', {
      script: (data) => localStorage.setItem('ts8_project_link_manager_v6', JSON.stringify(data)),
      arg: db
    });
    await page.waitForSelector('[data-pid="p1"]');
    await page.fill('#globalSearch', 'PB-FIND-ME-7788');
    await page.waitForSelector('.search-hit-banner');
    const banner = await page.locator('.search-hit-banner').innerText();
    assert.match(banner, /找到 1 處/);
    assert.match(banner, /Part B ID/);
    assert.match(banner, /PB-FIND-ME-7788/);
    const hit = await page.locator('.is-search-hit').count();
    assert.ok(hit >= 1);

    await page.fill('#globalSearch', '');
    await page.waitForTimeout(200);
    await page.fill('#dayFilterQ', '沒有這個隔離日');
    await page.waitForSelector('#dayFilterEmpty');
    assert.match(await page.locator('#dayFilterEmpty').innerText(), /沒有符合的隔離日/);
    await page.click('[data-act="clear-day-filter"]');
    assert.equal(await page.locator('#dayFilterQ').inputValue(), '');
    assert.equal(await page.locator('#dayFilterEmpty').count(), 0);

    await page.fill('#dayFilterQ', '沒有這個隔離日');
    await page.click('[data-pid="p2"]');
    assert.equal(await page.locator('#dayFilterQ').inputValue(), '');

    await page.click('[data-pid="p1"]');
    const toggle = page.locator('.day-toggle').first();
    await toggle.focus();
    if (await toggle.getAttribute('aria-expanded') === 'true') await page.keyboard.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await page.keyboard.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Tab');
    const edit = page.locator('[data-act="edit-day"]').first();
    assert.equal(await edit.evaluate((el) => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#modal.show [role="dialog"], #modal.show .modal');
    const first = await page.evaluate(() => document.activeElement && document.activeElement.id);
    assert.equal(first, 'm_date');
    const order = [];
    for (let i = 0; i < 12; i++) {
      order.push(await page.evaluate(() => document.activeElement && document.activeElement.id));
      await page.keyboard.press('Tab');
    }
    assert.equal(order[0], 'm_date');
    assert.ok(order.includes('m_save'), 'tab order: ' + order.join(','));
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'm_date');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'm_save');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('modal').classList.contains('show'));
    assert.equal(await edit.evaluate((el) => el === document.activeElement), true);

    await edit.click();
    await page.fill('#m_pbid', '');
    await page.click('#m_save');
    await page.click('[data-act="paste-slot"]');
    await page.fill('#m_url', 'javascript:alert(1)');
    await page.click('#m_save');
    await page.waitForSelector('#toast.show, .toast.show, #toast');
    const badHref = await page.locator('a[href^="javascript:"]').count();
    assert.equal(badHref, 0);
    await page.fill('#m_url', 'https://example.com/kept');
    await page.click('#m_save');
    await page.waitForSelector('a[href="https://example.com/kept"]');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('stats numbers stay usable when Chart.js is still loading or fails', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let releaseChart;
  const held = new Promise((resolve) => { releaseChart = resolve; });
  try {
    await blockProduction(context);
    await context.route('**/chart.umd.min.js', async (route) => {
      await held;
      await route.abort();
    });
    const ym = hkYm(new Date());
    const db = {
      projects: [{
        id: 'p1',
        name: '統計項目',
        code: '',
        jobNo: 'J1',
        pm: '',
        notes: '',
        createdAt: '2026-09-01',
        partAs: [{
          id: 'pa',
          label: 'Part A',
          eformId: '',
          docNo: '',
          status: '草稿',
          notes: '',
          links: [],
          days: [
            { id: 'd1', date: ym + '-02', label: '隔離日', partBSubmissionId: '', status: '已完結', notes: '', links: [] },
            { id: 'd2', date: ym + '-03', label: '隔離日', partBSubmissionId: '', status: '未開始', notes: '', links: [{ id: 'pdf', type: 'pdf_b2', label: '完整 PDF', url: 'https://example.com/done.pdf', notes: '', driveFileId: '', sourceEmailId: '' }] },
            { id: 'd3', date: '2020-01-04', label: '隔離日', partBSubmissionId: '', status: '已完結', notes: '', links: [] }
          ]
        }]
      }],
      meta: {},
      fsi: { cases: [], meta: {} }
    };
    const { page, errors } = await openPage(context, '/ts8.html', {
      script: (data) => localStorage.setItem('ts8_project_link_manager_v6', JSON.stringify(data)),
      arg: db
    });
    await page.click('#tabStats');
    await page.waitForSelector('[data-kpi="month"]');
    assert.equal(await page.locator('[data-kpi="total"]').innerText(), '3');
    assert.equal(await page.locator('[data-kpi="month"]').innerText(), '2');
    const year = ym.slice(0, 4);
    assert.equal(await page.locator('[data-kpi="year"]').innerText(), year === '2020' ? '3' : '2');
    assert.match(await page.locator('label[for="statsYearSelect"]').innerText(), /只影響「年內各月」/);
    assert.match(await page.locator('.jobs-table').innerText(), /統計項目/);
    assert.match(await page.locator('#trendWrap').innerText(), /圖表載入中/);
    await page.click('#tabLinks');
    releaseChart();
    await page.waitForTimeout(400);
    assert.match(await page.locator('#content').innerText(), /隔離日/);
    assert.equal(await page.locator('#trendWrap').count(), 0);
    assert.equal(await page.locator('.proj-item .name').innerText(), '統計項目');
    await page.click('#tabStats');
    await page.waitForSelector('#trendWrap');
    assert.match(await page.locator('#trendWrap').innerText(), /圖表暫時未能載入，數字與明細仍可使用/);
    assert.equal(await page.locator('[data-kpi="total"]').innerText(), '3');
    assert.match(await page.locator('.jobs-table').innerText(), /統計項目/);
    assert.deepEqual(errors, []);
  } finally {
    releaseChart();
    await context.close();
  }
});

test('pdf validation sends nothing for two files, and a failed replace keeps the old link', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const uploads = [];
  try {
    await blockProduction(context);
    await context.route('**/macros/s/**', async (route) => {
      uploads.push(route.request().postData() || '');
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"error":"nope"}' });
    });
    await context.addInitScript(() => {
      window.TS8_TEST_SESSION = {
        email: 'synthetic@example.com',
        emailVerified: true,
        getIdToken: async () => 'synthetic-token'
      };
    });
    const db = {
      projects: [project('p1', 'PDF 項目', {
        day: {
          links: [{
            id: 'pdf1',
            type: 'pdf_b2',
            label: '原本',
            url: 'https://example.com/original.pdf',
            notes: '',
            driveFileId: 'old',
            sourceEmailId: ''
          }]
        }
      })],
      meta: {},
      fsi: { cases: [], meta: {} }
    };
    const { page, errors } = await openPage(context, '/ts8.html', {
      script: (data) => localStorage.setItem('ts8_project_link_manager_v6', JSON.stringify(data)),
      arg: db
    });
    const slot = page.locator('[data-act="edit-slot"]');
    if (!(await slot.isVisible())) await page.click('.day-toggle');
    await slot.click();
    await page.waitForSelector('#m_dropzone');
    const multi = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['%PDF-1.4 a'], 'a.pdf', { type: 'application/pdf' }));
      dt.items.add(new File(['%PDF-1.4 b'], 'b.pdf', { type: 'application/pdf' }));
      const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
      document.getElementById('m_dropzone').dispatchEvent(event);
      return {
        files: event.dataTransfer ? event.dataTransfer.files.length : -1,
        status: document.getElementById('m_status').textContent
      };
    });
    assert.equal(multi.files, 2);
    assert.match(multi.status, /一次只可以上傳一個 PDF/);
    assert.equal(uploads.length, 0);
    const originalTile = page.locator('.tile-url[title="https://example.com/original.pdf"]');
    assert.match(await originalTile.innerText(), /original\.pdf/);

    const wrong = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
      document.getElementById('m_dropzone').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return document.getElementById('m_status').textContent;
    });
    assert.match(wrong, /只接受 PDF/);
    assert.equal(uploads.length, 0);

    let releaseUpload;
    const heldUpload = new Promise((resolve) => { releaseUpload = resolve; });
    await context.unroute('**/macros/s/**');
    await context.route('**/macros/s/**', async (route) => {
      uploads.push(route.request().postData() || '');
      await heldUpload;
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"error":"nope"}' });
    });
    const sending = page.setInputFiles('#m_file', { name: 'replacement.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 replacement') });
    await page.waitForFunction(() => document.getElementById('m_status').textContent.includes('上傳中'));
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['%PDF-1.4 c'], 'c.pdf', { type: 'application/pdf' }));
      document.getElementById('m_dropzone').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    assert.equal(uploads.length, 1);
    releaseUpload();
    await sending;
    await page.waitForFunction(() => document.getElementById('m_status').textContent.includes('上傳失敗'));
    assert.equal(uploads[0].includes('ts8-upload-2026'), false);
    assert.equal(uploads[0].includes('secret'), false);
    assert.match(await originalTile.innerText(), /original\.pdf/);
    assert.doesNotMatch(await page.locator('#content').innerText(), /replacement/);

    await page.evaluate(() => { window.TS8_TEST_FIELD_SYNC = 'fail'; });
    await context.unroute('**/macros/s/**');
    await context.route('**/macros/s/**', async (route) => {
      uploads.push('ok');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, id: 'new-file', url: 'https://example.com/replacement.pdf' })
      });
    });
    await page.setInputFiles('#m_file', { name: 'replacement.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 replacement') });
    await page.waitForFunction(() => document.getElementById('m_status').textContent.includes('欄位：寫入失敗'));
    const report = await page.locator('#m_status').innerText();
    assert.match(report, /Drive：已上傳/);
    assert.match(report, /欄位：寫入失敗/);
    assert.match(await originalTile.innerText(), /original\.pdf/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('firebase sdk failure keeps edits local and does not call the old backend', async () => {
  const context = await browser.newContext();
  try {
    const hits = await blockProduction(context);
    const { page, errors } = await openPage(context, '/ts8.html');
    await page.click('#btnNewProject');
    await page.fill('#m_name', '只存在這部裝置');
    await page.click('#m_save');
    await page.waitForFunction(() => document.getElementById('syncText').textContent === '待同步');
    assert.equal(await page.locator('.proj-item .name').innerText(), '只存在這部裝置');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.proj-item');
    assert.equal(await page.locator('.proj-item .name').innerText(), '只存在這部裝置');
    const status = await page.locator('#syncText').innerText();
    assert.equal(status === '待同步' || status === '已儲存於此裝置', true);
    assert.notEqual(status, '已同步');
    assert.equal(hits.some((url) => url.includes('script.google.com')), false);
    assert.equal(hits.some((url) => url.includes('googleapis.com')), false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('offline edit survives reload and retries after reconnect', async () => {
  const context = await browser.newContext();
  const sync = createStore([
    ['projects/p1', project('p1', '原來的項目')],
    ['meta/sync', { updatedAt: '2026-11-01T00:00:00.000Z', rev: 1, appMeta: { updatedAt: '2026-11-01T00:00:00.000Z', rev: 1 }, fsiMeta: {} }]
  ]);
  try {
    await context.exposeBinding('__ts8Store', async (_source, msg) => sync.handle(msg));
    await blockProduction(context, { fakeFirebase: true });
    const { page, errors } = await openPage(context, '/ts8.html');
    await page.waitForFunction(() => document.getElementById('syncText').textContent === '已同步');
    sync.setFailWrites(true);
    await page.click('#btnEditProject');
    await page.fill('#m_name', '離線修訂');
    await page.click('#m_save');
    await page.waitForFunction(() => document.getElementById('syncText').textContent === '同步失敗');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.proj-item');
    assert.equal(await page.locator('.proj-item .name').innerText(), '離線修訂');
    const queued = await page.evaluate(() => localStorage.getItem('ts8_sync_queue_v1') || '');
    assert.match(queued, /離線修訂/);
    await page.waitForFunction(() => {
      const text = document.getElementById('syncText').textContent;
      return text === '同步失敗' || text === '待同步';
    });
    sync.setFailWrites(false);
    await page.waitForFunction(() => document.getElementById('syncText').textContent === '已同步', null, { timeout: 20000 });
    assert.equal(sync.store.get('projects/p1').name, '離線修訂');
    assert.equal(sync.log.some((line) => line.includes('fsi_cases')), false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('two browsers edit different records and delete without clobbering', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const sync = createStore([
    ['projects/p1', project('p1', '項目一', { notes: '一' })],
    ['projects/p2', project('p2', '項目二', { notes: '二' })],
    ['projects/p3', project('p3', '項目三', { notes: '三' })],
    ['fsi_cases/c1', { id: 'c1', ref: 'FSI-KEEP', notes: '不要改' }],
    ['meta/sync', { updatedAt: '2026-11-01T00:00:00.000Z', rev: 1, appMeta: { updatedAt: '2026-11-01T00:00:00.000Z', rev: 1 }, fsiMeta: { updatedAt: '2026-11-01T00:00:00.000Z' } }]
  ]);
  try {
    await context.exposeBinding('__ts8Store', async (_source, msg) => sync.handle(msg));
    await blockProduction(context, { fakeFirebase: true });
    const a = await openPage(context, '/ts8.html');
    const b = await openPage(context, '/ts8.html');
    await a.page.waitForFunction(() => document.getElementById('syncText').textContent === '已同步');
    await b.page.waitForFunction(() => document.getElementById('syncText').textContent === '已同步');
    const resume = sync.pause();
    await a.page.click('[data-pid="p1"]');
    await a.page.click('#btnEditProject');
    await a.page.fill('#m_notes', '甲改備註');
    await a.page.click('#m_save');
    await b.page.click('[data-pid="p2"]');
    await b.page.click('#btnEditProject');
    await b.page.fill('#m_notes', '乙改備註');
    await b.page.click('#m_save');
    b.page.once('dialog', (dialog) => dialog.accept());
    await b.page.click('[data-pid="p3"]');
    await b.page.click('#btnEditProject');
    await b.page.click('#m_del');
    await a.page.waitForFunction(() => document.getElementById('syncText').textContent === '待同步');
    await b.page.waitForFunction(() => document.getElementById('syncText').textContent === '待同步');
    await a.page.waitForTimeout(500);
    resume();
    await a.page.waitForFunction(() => document.getElementById('syncText').textContent === '已同步', null, { timeout: 20000 });
    await b.page.waitForFunction(() => document.getElementById('syncText').textContent === '已同步', null, { timeout: 20000 });
    assert.equal(sync.store.get('projects/p1').notes, '甲改備註');
    assert.equal(sync.store.get('projects/p2').notes, '乙改備註');
    assert.equal(sync.store.has('projects/p3'), false);
    assert.equal(sync.store.get('fsi_cases/c1').notes, '不要改');
    assert.equal(sync.log.some((line) => line.includes('fsi_cases')), false);
    await a.page.click('[data-pid="p1"]');
    await a.page.click('#btnEditProject');
    assert.equal(await a.page.locator('#m_notes').inputValue(), '甲改備註');
    await a.page.click('#m_cancel');
    assert.equal(await b.page.locator('[data-pid="p3"]').count(), 0);
    assert.deepEqual(a.errors, []);
    assert.deepEqual(b.errors, []);
  } finally {
    await context.close();
  }
});

test('same-field conflict keeps the unsent local value and shows a prompt', async () => {
  const context = await browser.newContext();
  const sync = createStore([
    ['projects/p1', project('p1', '原名')],
    ['meta/sync', { updatedAt: '2026-11-01T00:00:00.000Z', rev: 1, appMeta: { updatedAt: '2026-11-01T00:00:00.000Z', rev: 1 }, fsiMeta: {} }]
  ]);
  try {
    await context.exposeBinding('__ts8Store', async (_source, msg) => sync.handle(msg));
    await blockProduction(context, { fakeFirebase: true });
    const a = await openPage(context, '/ts8.html');
    const b = await openPage(context, '/ts8.html');
    await a.page.waitForFunction(() => document.getElementById('syncText').textContent === '已同步');
    await b.page.waitForFunction(() => document.getElementById('syncText').textContent === '已同步');
    const resume = sync.pause();
    await a.page.click('#btnEditProject');
    await a.page.fill('#m_name', '甲的名稱');
    await a.page.click('#m_save');
    await b.page.click('#btnEditProject');
    await b.page.fill('#m_name', '乙的名稱');
    await b.page.click('#m_save');
    await a.page.waitForTimeout(500);
    resume();
    await a.page.waitForFunction(() => document.getElementById('syncText').textContent === '已同步' || document.getElementById('conflictDialog').classList.contains('show'), null, { timeout: 20000 });
    await b.page.waitForFunction(() => document.getElementById('syncText').textContent === '已同步' || document.getElementById('conflictDialog').classList.contains('show'), null, { timeout: 20000 });
    const dialogs = await Promise.all([a.page, b.page].map((page) => page.locator('#conflictDialog.show').count()));
    assert.ok(dialogs[0] + dialogs[1] >= 1);
    const prompted = (dialogs[1] ? b.page : a.page);
    assert.match(await prompted.locator('#conflictBody').innerText(), /尚未同步的內容已保留|已保留/);
    const winner = sync.store.get('projects/p1').name;
    assert.ok(winner === '甲的名稱' || winner === '乙的名稱');
    await a.page.waitForTimeout(600);
    await b.page.waitForTimeout(600);
    assert.equal(await a.page.locator('#projPickerName').innerText(), winner);
    assert.equal(await b.page.locator('#projPickerName').innerText(), winner);
  } finally {
    await context.close();
  }
});

test('fsi page does not write ts8 projects', async () => {
  const context = await browser.newContext();
  const sync = createStore([
    ['projects/p1', project('p1', 'TS8 原項目', { notes: 'ts8' })],
    ['fsi_cases/c1', { id: 'c1', ref: 'FSI-KEEP', location: '測試座', notes: '原註', status: 'open' }],
    ['meta/sync', { updatedAt: '2026-11-01T00:00:00.000Z', rev: 1, appMeta: {}, fsiMeta: { updatedAt: '2026-11-01T00:00:00.000Z' } }]
  ]);
  try {
    await context.exposeBinding('__ts8Store', async (_source, msg) => sync.handle(msg));
    await blockProduction(context, { fakeFirebase: true });
    const { page, errors } = await openPage(context, '/fsi.html');
    await page.waitForSelector('text=FSI-KEEP');
    await page.waitForTimeout(800);
    assert.equal(sync.store.get('projects/p1').notes, 'ts8');
    assert.equal(sync.log.some((line) => line.includes('projects/')), false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
