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
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (e) {
    return '';
  }
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

function adminHtml_() {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Console</title><style>'
    + 'body{font-family:system-ui,sans-serif;margin:0;background:#0f1412;color:#e8eee9;padding:24px}'
    + 'h1{font-size:1.1rem;margin:0 0 8px} .muted{color:#8a968e;font-size:.85rem;margin-bottom:18px}'
    + '.card{background:#1a221e;border:1px solid #2a3530;border-radius:12px;padding:14px 16px;margin-bottom:12px}'
    + '.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px}'
    + 'button{background:#3d8f6e;color:#fff;border:0;border-radius:8px;padding:8px 12px;cursor:pointer}'
    + 'button.ghost{background:transparent;border:1px solid #3a4540;color:#c5d0c8}'
    + 'table{width:100%;border-collapse:collapse;font-size:.8rem} th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #2a3530;vertical-align:top}'
    + '.kind-view{color:#7eb6ff}.kind-edit{color:#f0c674}.kind-upload{color:#c3e88d}'
    + '#gate,#app{display:none} #msg{color:#f07178;margin:8px 0}'
    + '</style>'
    + '<script src="https://accounts.google.com/gsi/client" async defer></script>'
    + '</head><body>'
    + '<div id="gate"><h1>Admin</h1><p class="muted">Sign in with the allowed Google account.</p>'
    + '<div id="gbtn"></div><div id="msg"></div></div>'
    + '<div id="app"><div class="row"><h1 style="flex:1;margin:0">Activity</h1>'
    + '<button type="button" id="btnRefresh">Refresh</button>'
    + '<button type="button" class="ghost" id="btnSignOut">Sign out</button></div>'
    + '<p class="muted" id="who"></p>'
    + '<div class="card"><strong>Summary</strong><div id="summary" class="muted" style="margin-top:8px"></div></div>'
    + '<div class="card"><table><thead><tr><th>Time (HKT)</th><th>Type</th><th>Detail</th><th>Client</th></tr></thead>'
    + '<tbody id="tbody"></tbody></table></div></div>'
    + '<script>'
    + 'const ALLOWED=' + JSON.stringify(ADMIN_EMAILS.map(function(x){return String(x).toLowerCase();})) + ';'
    + 'const EXEC="' + ScriptApp.getService().getUrl() + '";'
    + 'let idToken=null;let email=null;'
    + 'function $(id){return document.getElementById(id)}'
    + 'function showGate(){$("gate").style.display="block";$("app").style.display="none"}'
    + 'function showApp(){$("gate").style.display="none";$("app").style.display="block"}'
    + 'function hkt(iso){try{return new Date(iso).toLocaleString("zh-HK",{timeZone:"Asia/Hong_Kong"})}catch(e){return iso||""}}'
    + 'async function loadLogs(){'
    + '  const res=await fetch(EXEC,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},'
    + '    body:JSON.stringify({secret:"' + UPLOAD_SECRET + '",op:"adminLogs",idToken:idToken})});'
    + '  const data=JSON.parse(await res.text());'
    + '  if(!data.ok){ $("msg").textContent=data.error||"denied"; showGate(); return; }'
    + '  const ev=(data.events||[]).slice().reverse();'
    + '  let views=0,edits=0,uploads=0;'
    + '  ev.forEach(e=>{ if(e.kind==="view")views++; else if(e.kind==="edit")edits++; else if(e.kind==="upload")uploads++; });'
    + '  $("who").textContent="Signed in as "+email;'
    + '  $("summary").textContent="Events "+ev.length+" · views "+views+" · edits "+edits+" · uploads "+uploads;'
    + '  $("tbody").innerHTML=ev.slice(0,400).map(e=>"<tr><td>"+hkt(e.t)+"</td><td class=\\"kind-"+e.kind+"\\">"+e.kind+"</td><td>"'
    + '    +((e.path||"")+" "+(e.note||"")+" "+(e.rev!=null?("rev "+e.rev):"")).trim()'
    + '    +"</td><td>"+(e.cid||"")+"<br>"+(e.ua||"").slice(0,80)+"</td></tr>").join("");'
    + '}'
    + 'function onCred(resp){'
    + '  idToken=resp.credential;'
    + '  try{ const payload=JSON.parse(atob(idToken.split(".")[1].replace(/-/g,"+").replace(/_/g,"/")));'
    + '    email=(payload.email||"").toLowerCase();'
    + '    if(ALLOWED.indexOf(email)<0){ $("msg").textContent="This Google account is not allowed."; return; }'
    + '  }catch(e){ $("msg").textContent="Token parse failed"; return; }'
    + '  showApp(); loadLogs().catch(err=>{ $("msg").textContent=String(err); showGate(); });'
    + '}'
    + 'function initGis(){'
    + '  if(!window.google||!google.accounts||!google.accounts.id){ setTimeout(initGis,200); return; }'
    + '  // Client ID must be set after you create an OAuth Web client; until then session deploy works.'
    + '  const CLIENT_ID=window.ADMIN_GOOGLE_CLIENT_ID||"";'
    + '  if(!CLIENT_ID){'
    + '    $("msg").textContent="Waiting for Google session gate / Client ID. If this is the user-access deployment, continue.";'
    + '    // Try server session path without GIS'
    + '    fetch(EXEC,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},'
    + '      body:JSON.stringify({secret:"' + UPLOAD_SECRET + '",op:"adminLogs"})})'
    + '      .then(r=>r.json()).then(data=>{'
    + '        if(data.ok){ email=data.email||"admin"; idToken=null; showApp();'
    + '          const ev=(data.events||[]).slice().reverse();'
    + '          let views=0,edits=0,uploads=0;'
    + '          ev.forEach(e=>{ if(e.kind==="view")views++; else if(e.kind==="edit")edits++; else if(e.kind==="upload")uploads++; });'
    + '          $("who").textContent="Signed in as "+email;'
    + '          $("summary").textContent="Events "+ev.length+" · views "+views+" · edits "+edits+" · uploads "+uploads;'
    + '          $("tbody").innerHTML=ev.slice(0,400).map(e=>"<tr><td>"+hkt(e.t)+"</td><td class=\\"kind-"+e.kind+"\\">"+e.kind+"</td><td>"'
    + '            +((e.path||"")+" "+(e.note||"")+" "+(e.rev!=null?("rev "+e.rev):"")).trim()'
    + '            +"</td><td>"+(e.cid||"")+"<br>"+(e.ua||"").slice(0,80)+"</td></tr>").join("");'
    + '        } else { showGate(); $("msg").textContent="Deploy as \\"User accessing\\" or set Google Client ID."; }'
    + '      }).catch(()=>{ showGate(); });'
    + '    return;'
    + '  }'
    + '  google.accounts.id.initialize({client_id:CLIENT_ID,callback:onCred});'
    + '  google.accounts.id.renderButton($("gbtn"),{theme:"outline",size:"large"});'
    + '  showGate();'
    + '}'
    + '$("btnRefresh").onclick=()=>loadLogs();'
    + '$("btnSignOut").onclick=()=>{ idToken=null; email=null; showGate(); };'
    + 'window.onload=initGis;'
    + '</script></body></html>';
}

function doGet(e) {
  try {
    var op = (e && e.parameter && e.parameter.op) || '';
    var view = (e && e.parameter && e.parameter.view) || '';
    if (op === 'admin' || view === 'admin') {
      return HtmlService.createHtmlOutput(adminHtml_())
        .setTitle('Console')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
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
