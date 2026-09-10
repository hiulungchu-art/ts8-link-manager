const FOLDER_ID = '1FRJX-pH2gV_6bkv2HM9dt5S00Lmv_o2u';
const UPLOAD_SECRET = 'ts8-upload-2026';
const DB_FILE_NAME = 'ts8-shared-data.json';
const MAX_B64 = 12000000;

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

function doGet(e) {
  try {
    var op = (e && e.parameter && e.parameter.op) || '';
    if (op === 'db') {
      var file = getOrCreateDbFile_();
      return ContentService.createTextOutput(file.getBlob().getDataAsString() || '{"projects":[]}')
        .setMimeType(ContentService.MimeType.JSON);
    }
    return json_({ ok:true, service:'TS8 sync', ops:['db','saveDb','upload'], lww:true });
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
      // Also reject if client base is behind current (lost delete race)
      var base = data.baseUpdatedAt || '';
      if (curAt && base && base < curAt && newAt <= curAt) {
        return json_({ ok:false, error:'stale', current: current });
      }
      f.setContent(JSON.stringify(data.db));
      try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e2) {}
      return json_({ ok:true, saved:true, updatedAt: newAt || new Date().toISOString() });
    }
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
