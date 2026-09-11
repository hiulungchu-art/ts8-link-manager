const FOLDER_ID = '1FRJX-pH2gV_6bkv2HM9dt5S00Lmv_o2u';
const UPLOAD_SECRET = 'ts8-upload-2026';
const DB_FILE_NAME = 'ts8-shared-data.json';
const AUDIT_FILE_NAME = 'ts8-audit-private.json';
const MAX_B64 = 12000000;
const MAX_AUDIT = 2500;
/** Only this Google account may open the admin console (case-insensitive). */
const ADMIN_EMAILS = ['hlung.chu@connect.polyu.hk', 'hiulungchu@gmail.com'];

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateDbFile_() {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var it = folder.getFilesByName(DB_FILE_NAME);
  if (it.hasNext()) {
    var existing = it.next();
    try { existing.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
    return existing;
  }
  var f = folder.createFile(DB_FILE_NAME, '{"projects":[],"meta":{}}', MimeType.PLAIN_TEXT);
  f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return f;
}

function readDb_() {
  var f = getOrCreateDbFile_();
  try {
    return JSON.parse(f.getBlob().getDataAsString() || '{"projects":[],"meta":{}}');
  } catch (e) {
    return { projects: [], meta: {} };
  }
}

/** Private audit file — never share with link. */
function getOrCreateAuditFile_() {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var it = folder.getFilesByName(AUDIT_FILE_NAME);
  if (it.hasNext()) return it.next();
  return folder.createFile(AUDIT_FILE_NAME, '{"events":[]}', MimeType.PLAIN_TEXT);
}

function readAudit_() {
  try {
    var f = getOrCreateAuditFile_();
    var data = JSON.parse(f.getBlob().getDataAsString() || '{"events":[]}');
    if (!data.events) data.events = [];
    return data;
  } catch (e) {
    return { events: [] };
  }
}

function appendAudit_(entry) {
  try {
    var f = getOrCreateAuditFile_();
    var data = readAudit_();
    data.events.push(entry);
    if (data.events.length > MAX_AUDIT) {
      data.events = data.events.slice(data.events.length - MAX_AUDIT);
    }
    f.setContent(JSON.stringify(data));
  } catch (e) {}
}

function normalizeEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

function isAdminEmail_(email) {
  var e = normalizeEmail_(email);
  for (var i = 0; i < ADMIN_EMAILS.length; i++) {
    if (normalizeEmail_(ADMIN_EMAILS[i]) === e) return true;
  }
  return false;
}

function activeUserEmail_() {
  // Prefer active user; fall back to effective user (needed on some user-access web apps).
  try {
    var a = Session.getActiveUser().getEmail();
    if (a) return a;
  } catch (e) {}
  try {
    var ef = Session.getEffectiveUser().getEmail();
    if (ef) return ef;
  } catch (e2) {}
  return '';
}

function verifyGoogleIdToken_(idToken) {
  if (!idToken) return null;
  try {
    var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), {
      muteHttpExceptions: true,
      followRedirects: true
    });
    if (resp.getResponseCode() !== 200) return null;
    var data = JSON.parse(resp.getContentText());
    if (!data || !data.email) return null;
    if (String(data.email_verified) === 'false') return null;
    return data;
  } catch (e) {
    return null;
  }
}

function requireAdminFromPost_(data) {
  // Prefer Google ID token (account gate). Fallback: active session email on user-deployed web app.
  if (data && data.idToken) {
    var tok = verifyGoogleIdToken_(data.idToken);
    if (tok && isAdminEmail_(tok.email)) return normalizeEmail_(tok.email);
  }
  var sessionEmail = activeUserEmail_();
  if (sessionEmail && isAdminEmail_(sessionEmail)) return normalizeEmail_(sessionEmail);
  return null;
}


function adminKey_() {
  try {
    return PropertiesService.getScriptProperties().getProperty('ADMIN_KEY') || '';
  } catch (e) {
    return '';
  }
}

function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatHkt_(iso) {
  try {
    return Utilities.formatDate(new Date(iso), 'Asia/Hong_Kong', 'yyyy-MM-dd HH:mm:ss');
  } catch (e) {
    return String(iso || '');
  }
}

function adminForbiddenHtml_(email) {
  var msg = email
    ? ('Signed in as ' + escapeHtml_(email) + ', but this account is not allowed.')
    : 'Please open this link while signed into an allowed Google account.';
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Console</title><style>body{font-family:system-ui,sans-serif;background:#0f1412;color:#e8eee9;padding:24px}'
    + '.muted{color:#8a968e} .err{color:#f07178;margin-top:12px}</style></head><body>'
    + '<h1>Admin</h1><p class="muted">Restricted console.</p>'
    + '<p class="err">' + msg + '</p>'
    + '<p class="muted">Allowed: hlung.chu@connect.polyu.hk · hiulungchu@gmail.com</p>'
    + '</body></html>';
}

function adminPageHtml_(email, events) {
  events = events || [];
  var views = 0, edits = 0, uploads = 0;
  var rows = [];
  for (var i = events.length - 1; i >= 0 && rows.length < 400; i--) {
    var e = events[i] || {};
    if (e.kind === 'view') views++;
    else if (e.kind === 'edit') edits++;
    else if (e.kind === 'upload') uploads++;
    var detail = [e.path || '', e.note || '', (e.rev != null ? ('rev ' + e.rev) : '')].join(' ').replace(/\s+/g, ' ').trim();
    rows.push('<tr><td>' + escapeHtml_(formatHkt_(e.t)) + '</td><td class="kind-' + escapeHtml_(e.kind || '') + '">'
      + escapeHtml_(e.kind || '') + '</td><td>' + escapeHtml_(detail) + '</td><td>'
      + escapeHtml_(e.cid || '') + '<br>' + escapeHtml_(String(e.ua || '').slice(0, 80)) + '</td></tr>');
  }
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Console</title><style>'
    + 'body{font-family:system-ui,sans-serif;margin:0;background:#0f1412;color:#e8eee9;padding:20px}'
    + 'h1{font-size:1.15rem;margin:0 0 6px} .muted{color:#8a968e;font-size:.85rem;margin:0 0 14px}'
    + '.card{background:#1a221e;border:1px solid #2a3530;border-radius:12px;padding:14px 16px;margin-bottom:12px}'
    + '.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}'
    + 'a.btn,button{background:#3d8f6e;color:#fff;border:0;border-radius:8px;padding:8px 12px;cursor:pointer;text-decoration:none;font:inherit}'
    + 'table{width:100%;border-collapse:collapse;font-size:.78rem} th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #2a3530;vertical-align:top;word-break:break-word}'
    + '.kind-view{color:#7eb6ff}.kind-edit{color:#f0c674}.kind-upload{color:#c3e88d}'
    + '</style></head><body>'
    + '<div class="row"><h1 style="flex:1;margin:0">Activity</h1>'
    + '<a class="btn" href="?op=admin">Refresh</a></div>'
    + '<p class="muted">Signed in as ' + escapeHtml_(email) + '</p>'
    + '<div class="card"><strong>Summary</strong><div class="muted" style="margin-top:8px">Events '
    + events.length + ' · views ' + views + ' · edits ' + edits + ' · uploads ' + uploads + '</div></div>'
    + '<div class="card"><table><thead><tr><th>Time (HKT)</th><th>Type</th><th>Detail</th><th>Client</th></tr></thead><tbody>'
    + (rows.length ? rows.join('') : '<tr><td colspan="4" class="muted">No events yet. Open the public site once to generate a view ping.</td></tr>')
    + '</tbody></table></div>'
    + '</body></html>';
}

/** Server-rendered admin: works on user-access deployment without client GIS. */
function serveAdmin_(e) {
  var key = '';
  try { key = String((e && e.parameter && e.parameter.k) || ''); } catch (err) {}
  var email = normalizeEmail_(activeUserEmail_());
  var expected = adminKey_();
  var keyOk = expected && key && key === expected;
  var emailOk = isAdminEmail_(email);
  // Plain server-rendered HtmlService (no client JS) — ContentService HTML shows as source text.
  var html;
  if (!keyOk && !emailOk) {
    html = adminForbiddenHtml_(email);
  } else {
    var who = emailOk ? email : ('key:' + (email || 'private'));
    var audit = readAudit_();
    html = adminPageHtml_(who, audit.events || []);
  }
  return HtmlService.createHtmlOutput(html)
    .setTitle('Console')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doGet(e) {
  try {
    var op = (e && e.parameter && e.parameter.op) || '';
    var view = (e && e.parameter && e.parameter.view) || '';
    if (op === 'adminSelftest') {
      var expected = adminKey_();
      var key = (e && e.parameter && e.parameter.k) || '';
      return json_({
        ok: true,
        hasAdminKey: !!expected,
        keyMatch: !!(expected && key && key === expected),
        email: normalizeEmail_(activeUserEmail_()),
        events: (readAudit_().events || []).length
      });
    }
    if (op === 'admin' || view === 'admin') {
      return serveAdmin_(e);
    }
    if (op === 'db') {
      var file = getOrCreateDbFile_();
      return ContentService.createTextOutput(file.getBlob().getDataAsString() || '{"projects":[]}')
        .setMimeType(ContentService.MimeType.JSON);
    }
    return json_({ ok:true, service:'TS8 sync', ops:['db','saveDb','upload','ping','adminLogs'], lww:true });
  } catch (err) {
    return json_({ ok:false, error:String(err) });
  }
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if (!data || data.secret !== UPLOAD_SECRET) {
      return json_({ ok:false, error:'unauthorized' });
    }

    if (data.op === 'ping') {
      appendAudit_({
        t: new Date().toISOString(),
        kind: 'view',
        path: String(data.path || '').slice(0, 200),
        ref: String(data.ref || '').slice(0, 300),
        cid: String(data.cid || '').slice(0, 64),
        ua: String(data.ua || '').slice(0, 180)
      });
      return json_({ ok:true });
    }

    if (data.op === 'adminLogs') {
      var adminEmail = requireAdminFromPost_(data);
      if (!adminEmail) return json_({ ok:false, error:'forbidden' });
      var audit = readAudit_();
      return json_({ ok:true, email: adminEmail, events: audit.events || [] });
    }

    if (data.op === 'saveDb') {
      if (!data.db || !data.db.projects) {
        return json_({ ok:false, error:'invalid db' });
      }
      var f = getOrCreateDbFile_();
      var current = readDb_();
      var curAt = (current.meta && current.meta.updatedAt) || '';
      var newAt = (data.db.meta && data.db.meta.updatedAt) || '';
      if (curAt && newAt && newAt < curAt) {
        return json_({ ok:false, error:'stale', current: current });
      }
      var base = data.baseUpdatedAt || '';
      if (curAt && base && base < curAt && newAt <= curAt) {
        return json_({ ok:false, error:'stale', current: current });
      }
      f.setContent(JSON.stringify(data.db));
      try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e2) {}
      appendAudit_({
        t: new Date().toISOString(),
        kind: 'edit',
        path: String(data.page || '').slice(0, 200),
        note: String(data.note || 'saveDb').slice(0, 120),
        rev: (data.db.meta && data.db.meta.rev) || null,
        cid: String(data.cid || '').slice(0, 64),
        ua: String(data.ua || '').slice(0, 180)
      });
      return json_({ ok:true, saved:true, updatedAt: newAt || new Date().toISOString() });
    }

    // PDF upload
    var name = String(data.filename || 'upload.pdf');
    if (!/\.pdf$/i.test(name)) {
      return json_({ ok:false, error:'only pdf allowed' });
    }
    var b64 = String(data.base64 || '');
    if (!b64 || b64.length > MAX_B64) {
      return json_({ ok:false, error:'invalid or too large' });
    }
    var mime = data.mimeType || 'application/pdf';
    var safe = name.replace(/[^\w.\u4e00-\u9fff\- ()\[\]]+/g, '_');
    var bytes = Utilities.base64Decode(b64);
    var blob = Utilities.newBlob(bytes, mime, safe);
    var folder = DriveApp.getFolderById(FOLDER_ID);
    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    appendAudit_({
      t: new Date().toISOString(),
      kind: 'upload',
      path: String(data.page || '').slice(0, 200),
      note: safe,
      cid: String(data.cid || '').slice(0, 64),
      ua: String(data.ua || '').slice(0, 180)
    });
    return json_({
      ok:true,
      id: file.getId(),
      url: 'https://drive.google.com/file/d/' + file.getId() + '/view',
      name: file.getName()
    });
  } catch (err) {
    return json_({ ok:false, error: String(err) });
  }
}
