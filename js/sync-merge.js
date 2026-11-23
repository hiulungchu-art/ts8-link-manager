/**
 * Ordered offline intents for TS8 projects and flat record sets (FSI cases).
 * A missing record is a delete only when the baseline still had it and the
 * local edit removed it. Replaying the queue onto a server snapshot keeps
 * unsent local field values when the same field also changed remotely.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TS8SyncMerge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PROJECT_FIELDS = ['name', 'code', 'jobNo', 'pm', 'notes', 'createdAt'];
  var PARTA_FIELDS = ['label', 'eformId', 'docNo', 'status', 'notes'];
  var DAY_FIELDS = ['date', 'label', 'partBSubmissionId', 'status', 'notes'];
  var LINK_FIELDS = ['type', 'label', 'url', 'notes', 'driveFileId', 'sourceEmailId'];

  var FIELD_LABELS = {
    name: '項目名稱',
    code: '簡稱',
    jobNo: '工程號碼',
    pm: '項目經理',
    notes: '備註',
    createdAt: '建立日期',
    label: '名稱',
    eformId: 'E-Form ID',
    docNo: '檔案編號',
    status: '狀態',
    date: '日期',
    partBSubmissionId: 'Part B ID',
    url: '連結',
    driveFileId: 'Drive 檔案',
    sourceEmailId: '來源電郵',
    type: '類型',
    '刪除': '刪除'
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value == null ? null : value));
  }

  function sval(value) {
    if (value == null) return '';
    if (typeof value === 'object') return stableJson(value);
    return String(value);
  }

  function stableJson(value) {
    return JSON.stringify(sortValue(value));
  }

  function sortValue(value) {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).sort().forEach(function (key) {
        if (value[key] !== undefined) out[key] = sortValue(value[key]);
      });
      return out;
    }
    return value;
  }

  function byId(list) {
    var map = new Map();
    (list || []).forEach(function (item) {
      if (item && item.id) map.set(item.id, item);
    });
    return map;
  }

  function fieldChanges(base, next, fields) {
    var changes = {};
    var baseVals = {};
    fields.forEach(function (field) {
      var before = base ? sval(base[field]) : '';
      var after = next ? sval(next[field]) : '';
      if (before !== after) {
        changes[field] = next && next[field] != null ? next[field] : '';
        baseVals[field] = base && base[field] != null ? base[field] : '';
      }
    });
    return changes;
  }

  function hasKeys(obj) {
    return obj && Object.keys(obj).length > 0;
  }

  function pushOp(ops, op) {
    op.seq = ops.length + 1;
    ops.push(op);
  }

  function placeLabel(kind, record) {
    if (!record) return '';
    if (kind === 'day') return record.date || record.label || '';
    return record.label || record.name || record.ref || record.id || '';
  }

  function diffLinks(ops, ctx, baseLinks, localLinks) {
    var baseMap = byId(baseLinks);
    var localMap = byId(localLinks);
    var ids = new Set([].concat(Array.from(baseMap.keys()), Array.from(localMap.keys())));
    ids.forEach(function (id) {
      var baseLink = baseMap.get(id);
      var localLink = localMap.get(id);
      if (baseLink && !localLink) {
        pushOp(ops, Object.assign({}, ctx, {
          kind: 'link-delete',
          linkId: id,
          linkType: baseLink.type || '',
          baseLink: clone(baseLink)
        }));
        return;
      }
      if (!localLink) return;
      var changes = baseLink ? fieldChanges(baseLink, localLink, LINK_FIELDS) : null;
      if (!baseLink || hasKeys(changes)) {
        pushOp(ops, Object.assign({}, ctx, {
          kind: 'link-upsert',
          linkId: id,
          link: clone(localLink),
          baseLink: baseLink ? clone(baseLink) : null,
          fields: changes || fieldChanges({}, localLink, LINK_FIELDS),
          base: baseLink ? pick(baseLink, LINK_FIELDS) : {}
        }));
      }
    });
  }

  function diffDays(ops, ctx, baseDays, localDays) {
    var baseMap = byId(baseDays);
    var localMap = byId(localDays);
    var ids = new Set([].concat(Array.from(baseMap.keys()), Array.from(localMap.keys())));
    ids.forEach(function (id) {
      var baseDay = baseMap.get(id);
      var localDay = localMap.get(id);
      var here = Object.assign({}, ctx, { dayId: id, dayLabel: placeLabel('day', localDay || baseDay) });
      if (baseDay && !localDay) {
        pushOp(ops, Object.assign({}, here, { kind: 'day-delete', baseDay: clone(baseDay) }));
        return;
      }
      if (!baseDay && localDay) {
        pushOp(ops, Object.assign({}, here, { kind: 'day-create', day: clone(localDay) }));
        return;
      }
      if (!baseDay || !localDay) return;
      var changes = fieldChanges(baseDay, localDay, DAY_FIELDS);
      if (hasKeys(changes)) {
        pushOp(ops, Object.assign({}, here, {
          kind: 'day-fields',
          fields: changes,
          base: pick(baseDay, Object.keys(changes))
        }));
      }
      diffLinks(ops, here, baseDay.links, localDay.links);
    });
  }

  function diffPartAs(ops, projectId, basePartAs, localPartAs) {
    var baseMap = byId(basePartAs);
    var localMap = byId(localPartAs);
    var ids = new Set([].concat(Array.from(baseMap.keys()), Array.from(localMap.keys())));
    ids.forEach(function (id) {
      var basePart = baseMap.get(id);
      var localPart = localMap.get(id);
      var ctx = { projectId: projectId, partAId: id, partALabel: placeLabel('parta', localPart || basePart) };
      if (basePart && !localPart) {
        pushOp(ops, Object.assign({}, ctx, { kind: 'parta-delete', basePart: clone(basePart) }));
        return;
      }
      if (!basePart && localPart) {
        pushOp(ops, Object.assign({}, ctx, { kind: 'parta-create', partA: clone(localPart) }));
        return;
      }
      if (!basePart || !localPart) return;
      var changes = fieldChanges(basePart, localPart, PARTA_FIELDS);
      if (hasKeys(changes)) {
        pushOp(ops, Object.assign({}, ctx, {
          kind: 'parta-fields',
          fields: changes,
          base: pick(basePart, Object.keys(changes))
        }));
      }
      diffLinks(ops, Object.assign({}, ctx, { dayId: null }), basePart.links, localPart.links);
      diffDays(ops, ctx, basePart.days, localPart.days);
    });
  }

  function pick(record, fields) {
    var out = {};
    (fields || []).forEach(function (field) {
      out[field] = record && record[field] != null ? record[field] : '';
    });
    return out;
  }

  /**
   * Diff local against baseline. Records present only on a later server
   * snapshot are not in this diff, so they are not deletes.
   * Pass baseProjects = null only when there is no baseline (no deletes).
   */
  function diffProjects(baseProjects, localProjects) {
    var ops = [];
    var unknown = baseProjects == null;
    var baseMap = unknown ? new Map() : byId(baseProjects);
    var localMap = byId(localProjects || []);
    var ids = new Set([].concat(Array.from(baseMap.keys()), Array.from(localMap.keys())));
    ids.forEach(function (id) {
      var baseProject = baseMap.get(id);
      var localProject = localMap.get(id);
      if (baseProject && !localProject) {
        if (unknown) return;
        pushOp(ops, {
          kind: 'project-delete',
          projectId: id,
          projectLabel: baseProject.name || id,
          baseProject: clone(baseProject)
        });
        return;
      }
      if (!baseProject && localProject) {
        pushOp(ops, {
          kind: 'project-create',
          projectId: id,
          projectLabel: localProject.name || id,
          project: clone(localProject)
        });
        return;
      }
      if (!baseProject || !localProject) return;
      var changes = fieldChanges(baseProject, localProject, PROJECT_FIELDS);
      if (hasKeys(changes)) {
        pushOp(ops, {
          kind: 'project-fields',
          projectId: id,
          projectLabel: localProject.name || baseProject.name || id,
          fields: changes,
          base: pick(baseProject, Object.keys(changes))
        });
      }
      diffPartAs(ops, id, baseProject.partAs, localProject.partAs);
    });
    return ops;
  }

  function findById(list, id) {
    for (var i = 0; i < (list || []).length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  function conflict(conflicts, path, field, localValue, remoteValue) {
    conflicts.push({
      path: path,
      field: field,
      fieldLabel: FIELD_LABELS[field] || field,
      local: localValue,
      remote: remoteValue
    });
  }

  function applyFieldMap(target, fields, base, path, conflicts) {
    Object.keys(fields || {}).forEach(function (field) {
      var serverVal = sval(target[field]);
      var baseVal = base ? sval(base[field]) : '';
      var localVal = sval(fields[field]);
      if (serverVal !== baseVal && serverVal !== localVal) {
        conflict(conflicts, path, field, fields[field], target[field]);
      }
      target[field] = fields[field];
    });
  }

  function projectPath(op, project) {
    return '項目 ' + ((project && project.name) || op.projectLabel || op.projectId || '');
  }

  function partPath(op, part) {
    return projectPath(op) + ' · Part A ' + ((part && (part.label || part.docNo)) || op.partALabel || op.partAId || '');
  }

  function dayPath(op, day) {
    return partPath(op) + ' · 隔離日 ' + ((day && day.date) || op.dayLabel || op.dayId || '');
  }

  function linkPath(op, link) {
    var parent = op.dayId ? dayPath(op) : partPath(op);
    var name = (link && (link.label || link.type)) || op.linkType || '連結';
    return parent + ' · ' + name;
  }

  function ensureList(owner, key) {
    if (!owner[key]) owner[key] = [];
    return owner[key];
  }

  function ensureProject(projects, conflicts, op, fallback) {
    var found = findById(projects, op.projectId);
    if (found) return found;
    if (!fallback) return null;
    var created = clone(fallback);
    created.id = op.projectId;
    created.partAs = created.partAs || [];
    projects.push(created);
    conflict(conflicts, projectPath(op, created), '項目', '保留尚未同步的內容', '雲端沒有此項目');
    return created;
  }

  function ensurePart(project, conflicts, op, fallback) {
    var parts = ensureList(project, 'partAs');
    var found = findById(parts, op.partAId);
    if (found) return found;
    if (!fallback) return null;
    var created = clone(fallback);
    created.id = op.partAId;
    created.links = created.links || [];
    created.days = created.days || [];
    parts.push(created);
    conflict(conflicts, partPath(op, created), 'Part A', '保留尚未同步的內容', '雲端沒有此 Part A');
    return created;
  }

  function ensureDay(part, conflicts, op, fallback) {
    var days = ensureList(part, 'days');
    var found = findById(days, op.dayId);
    if (found) return found;
    if (!fallback) return null;
    var created = clone(fallback);
    created.id = op.dayId;
    created.links = created.links || [];
    days.push(created);
    conflict(conflicts, dayPath(op, created), '隔離日', '保留尚未同步的內容', '雲端沒有此隔離日');
    return created;
  }

  function linkList(op, part) {
    if (op.dayId) {
      var day = findById(part.days, op.dayId);
      if (!day) return null;
      return ensureList(day, 'links');
    }
    return ensureList(part, 'links');
  }

  function sameRecord(a, b) {
    if (!a || !b) return false;
    return stableJson(a) === stableJson(b);
  }

  function applyOps(serverProjects, ops) {
    var projects = clone(serverProjects || []);
    var conflicts = [];
    (ops || []).forEach(function (op) {
      if (!op || !op.kind) return;
      if (op.kind === 'project-delete') {
        var existing = findById(projects, op.projectId);
        if (existing && op.baseProject && !sameRecord(existing, op.baseProject)) {
          conflict(conflicts, projectPath(op, existing), '刪除', '刪除', '雲端有較新修改');
        }
        projects = projects.filter(function (project) { return project.id !== op.projectId; });
        return;
      }
      if (op.kind === 'project-create') {
        if (!findById(projects, op.projectId)) {
          projects.push(clone(op.project));
          return;
        }
        var shell = { id: op.projectId, partAs: [] };
        var nested = diffProjects([shell], [op.project]).filter(function (item) {
          return item.kind !== 'project-delete';
        });
        var nestedResult = applyOps([findById(projects, op.projectId)], nested);
        var replacement = nestedResult.projects[0];
        projects = projects.map(function (project) {
          return project.id === op.projectId ? replacement : project;
        });
        conflicts = conflicts.concat(nestedResult.conflicts);
        return;
      }
      if (op.kind === 'project-fields') {
        var project = ensureProject(projects, conflicts, op, { id: op.projectId, name: op.projectLabel || '', partAs: [] });
        if (!project) return;
        applyFieldMap(project, op.fields, op.base, projectPath(op, project), conflicts);
        return;
      }
      if (op.kind === 'parta-delete') {
        var host = findById(projects, op.projectId);
        if (!host) return;
        var part = findById(host.partAs, op.partAId);
        if (part && op.basePart && !sameRecord(part, op.basePart)) {
          conflict(conflicts, partPath(op, part), '刪除', '刪除', '雲端有較新修改');
        }
        host.partAs = (host.partAs || []).filter(function (item) { return item.id !== op.partAId; });
        return;
      }
      if (op.kind === 'parta-create') {
        var owner = ensureProject(projects, conflicts, op, { id: op.projectId, name: op.projectLabel || '', partAs: [] });
        if (!owner) return;
        if (!findById(owner.partAs, op.partAId)) owner.partAs.push(clone(op.partA));
        else {
          var partTarget = findById(owner.partAs, op.partAId);
          applyFieldMap(partTarget, pick(op.partA, PARTA_FIELDS), {}, partPath(op, partTarget), conflicts);
        }
        return;
      }
      if (op.kind === 'parta-fields') {
        var partHost = ensureProject(projects, conflicts, op, { id: op.projectId, name: '', partAs: [] });
        if (!partHost) return;
        var partRow = ensurePart(partHost, conflicts, op, { id: op.partAId, label: op.partALabel || '', links: [], days: [] });
        if (!partRow) return;
        applyFieldMap(partRow, op.fields, op.base, partPath(op, partRow), conflicts);
        return;
      }
      if (op.kind === 'day-delete') {
        var dayHost = findById(projects, op.projectId);
        var dayPart = dayHost && findById(dayHost.partAs, op.partAId);
        if (!dayPart) return;
        var day = findById(dayPart.days, op.dayId);
        if (day && op.baseDay && !sameRecord(day, op.baseDay)) {
          conflict(conflicts, dayPath(op, day), '刪除', '刪除', '雲端有較新修改');
        }
        dayPart.days = (dayPart.days || []).filter(function (item) { return item.id !== op.dayId; });
        return;
      }
      if (op.kind === 'day-create') {
        var dayOwner = ensureProject(projects, conflicts, op, { id: op.projectId, name: '', partAs: [] });
        if (!dayOwner) return;
        var dayParent = ensurePart(dayOwner, conflicts, op, { id: op.partAId, label: op.partALabel || '', links: [], days: [] });
        if (!dayParent) return;
        if (!findById(dayParent.days, op.dayId)) ensureList(dayParent, 'days').push(clone(op.day));
        return;
      }
      if (op.kind === 'day-fields') {
        var dayProject = ensureProject(projects, conflicts, op, { id: op.projectId, name: '', partAs: [] });
        if (!dayProject) return;
        var dayPartRow = ensurePart(dayProject, conflicts, op, { id: op.partAId, label: '', links: [], days: [] });
        if (!dayPartRow) return;
        var dayRow = ensureDay(dayPartRow, conflicts, op, { id: op.dayId, date: op.dayLabel || '', links: [] });
        if (!dayRow) return;
        applyFieldMap(dayRow, op.fields, op.base, dayPath(op, dayRow), conflicts);
        return;
      }
      if (op.kind === 'link-delete' || op.kind === 'link-upsert') {
        var linkProject = ensureProject(projects, conflicts, op, { id: op.projectId, name: '', partAs: [] });
        if (!linkProject) return;
        var linkPart = ensurePart(linkProject, conflicts, op, { id: op.partAId, label: '', links: [], days: [] });
        if (!linkPart) return;
        if (op.dayId) ensureDay(linkPart, conflicts, op, { id: op.dayId, date: op.dayLabel || '', links: [] });
        var links = linkList(op, linkPart);
        if (!links) return;
        if (op.kind === 'link-delete') {
          var current = findById(links, op.linkId);
          if (current && op.baseLink && !sameRecord(current, op.baseLink)) {
            conflict(conflicts, linkPath(op, current), '刪除', '刪除', '雲端有較新修改');
          }
          var nextLinks = links.filter(function (item) { return item.id !== op.linkId; });
          if (op.dayId) findById(linkPart.days, op.dayId).links = nextLinks;
          else linkPart.links = nextLinks;
          return;
        }
        var serverLink = findById(links, op.linkId);
        if (!serverLink) {
          links.push(clone(op.link));
          return;
        }
        applyFieldMap(serverLink, pick(op.link, LINK_FIELDS), op.base || {}, linkPath(op, serverLink), conflicts);
      }
    });
    return { projects: projects, conflicts: dedupeConflicts(conflicts) };
  }

  function dedupeConflicts(list) {
    var seen = new Set();
    var out = [];
    (list || []).forEach(function (item) {
      var key = item.path + '|' + item.field + '|' + sval(item.local) + '|' + sval(item.remote);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(item);
    });
    return out;
  }

  function recordFieldNames(baseList, localList, serverList) {
    var names = new Set();
    [baseList, localList, serverList].forEach(function (list) {
      (list || []).forEach(function (record) {
        if (!record) return;
        Object.keys(record).forEach(function (key) {
          if (key !== 'id') names.add(key);
        });
      });
    });
    return Array.from(names);
  }

  function diffRecords(baseList, localList, fields) {
    var ops = [];
    var unknown = baseList == null;
    var baseMap = unknown ? new Map() : byId(baseList);
    var localMap = byId(localList || []);
    var useFields = fields && fields.length ? fields : recordFieldNames(baseList, localList, []);
    var ids = new Set([].concat(Array.from(baseMap.keys()), Array.from(localMap.keys())));
    ids.forEach(function (id) {
      var baseRec = baseMap.get(id);
      var localRec = localMap.get(id);
      if (baseRec && !localRec) {
        if (!unknown) pushOp(ops, { kind: 'record-delete', id: id, base: clone(baseRec) });
        return;
      }
      if (!localRec) return;
      if (!baseRec) {
        pushOp(ops, { kind: 'record-upsert', id: id, record: clone(localRec), base: null });
        return;
      }
      var changes = fieldChanges(baseRec, localRec, useFields);
      if (hasKeys(changes)) {
        pushOp(ops, {
          kind: 'record-upsert',
          id: id,
          record: clone(localRec),
          fields: changes,
          base: pick(baseRec, Object.keys(changes))
        });
      }
    });
    return ops;
  }

  function applyRecordOps(serverList, ops, fields) {
    var records = clone(serverList || []);
    var conflicts = [];
    var useFields = fields && fields.length ? fields : null;
    (ops || []).forEach(function (op) {
      if (op.kind === 'record-delete') {
        var existing = findById(records, op.id);
        if (existing && op.base && !sameRecord(existing, op.base)) {
          conflict(conflicts, '記錄 ' + op.id, '刪除', '刪除', '雲端有較新修改');
        }
        records = records.filter(function (record) { return record.id !== op.id; });
        return;
      }
      if (op.kind !== 'record-upsert') return;
      var target = findById(records, op.id);
      if (!target) {
        records.push(clone(op.record));
        return;
      }
      var names = useFields || Object.keys(op.fields || op.record || {});
      var localFields = op.fields || pick(op.record, names);
      applyFieldMap(target, localFields, op.base || {}, '記錄 ' + (op.record && (op.record.ref || op.record.name) || op.id), conflicts);
    });
    return { records: records, conflicts: dedupeConflicts(conflicts) };
  }

  function mergeRecords(baseList, localList, serverList) {
    var fields = recordFieldNames(baseList, localList, serverList);
    var ops = diffRecords(baseList, localList, fields);
    var applied = applyRecordOps(serverList, ops, fields);
    applied.ops = ops;
    return applied;
  }

  function parseTime(iso) {
    if (!iso) return 0;
    var n = Date.parse(iso);
    return Number.isFinite(n) ? n : 0;
  }

  function syncLabel(state) {
    state = state || {};
    if (state.failed) return '同步失敗';
    if (state.pending) return '待同步';
    if (state.transport === 'firestore' && state.confirmed) return '已同步';
    return '已儲存於此裝置';
  }

  /**
   * Page-local queue. getProjects/setProjects talk to the live db.
   * Deletes exist only as queued ops, never as "id missing from a partial snapshot".
   */
  function createSyncSession(hooks) {
    var queue = [];
    var seq = 1;
    var lastSaved = [];
    var established = false;

    function read() {
      return hooks && typeof hooks.getProjects === 'function' ? (hooks.getProjects() || []) : [];
    }

    function write(projects) {
      if (hooks && typeof hooks.setProjects === 'function') hooks.setProjects(projects);
    }

    function snapshot() {
      return { seq: seq, ops: clone(queue), established: established };
    }

    function restore(data) {
      queue = data && Array.isArray(data.ops) ? clone(data.ops) : [];
      seq = data && data.seq ? data.seq : (queue.reduce(function (max, op) {
        return Math.max(max, op.seq || 0);
      }, 0) + 1);
      established = !!(data && data.established);
      lastSaved = clone(read());
    }

    function capture() {
      var ops = diffProjects(lastSaved, read());
      ops.forEach(function (op) {
        op.seq = seq++;
        queue.push(op);
      });
      lastSaved = clone(read());
      return ops.length;
    }

    function acceptRemote(serverProjects, serverUpdatedAt, localUpdatedAt) {
      var conflicts = [];
      if (!established && !queue.length && parseTime(localUpdatedAt) > parseTime(serverUpdatedAt)) {
        diffProjects(serverProjects || [], read()).forEach(function (op) {
          if (op.kind.indexOf('delete') !== -1) return;
          op.seq = seq++;
          op.unknownBase = true;
          queue.push(op);
        });
      }
      var applied = applyOps(serverProjects || [], queue);
      write(applied.projects);
      conflicts = applied.conflicts.slice();
      if (!established) {
        queue.forEach(function (op) {
          if (!op.unknownBase || !op.fields) return;
          Object.keys(op.fields).forEach(function (field) {
            conflicts.push({
              path: op.projectLabel || op.projectId,
              field: field,
              fieldLabel: FIELD_LABELS[field] || field,
              local: op.fields[field],
              remote: op.base ? op.base[field] : '',
              unknownBase: true
            });
          });
        });
        conflicts = dedupeConflicts(conflicts);
      }
      established = true;
      lastSaved = clone(read());
      return { projects: read(), conflicts: conflicts, pending: queue.length > 0 };
    }

    function buildWrites() {
      var groups = new Map();
      queue.forEach(function (op) {
        if (!groups.has(op.projectId)) groups.set(op.projectId, []);
        groups.get(op.projectId).push(op);
      });
      var writes = [];
      groups.forEach(function (ops, id) {
        writes.push({
          id: id,
          ops: clone(ops),
          local: clone(findById(read(), id))
        });
      });
      return { projectWrites: writes, projectDeletes: [], sentSeq: queue.reduce(function (max, op) {
        return Math.max(max, op.seq || 0);
      }, 0) };
    }

    function acknowledge(sentSeq, written) {
      var raced = queue.filter(function (op) { return (op.seq || 0) > sentSeq; });
      queue = raced.map(function (op) { return clone(op); });
      (written || []).forEach(function (item) {
        var projects = read().slice();
        if (item.deleted) {
          write(projects.filter(function (project) { return project.id !== item.id; }));
          return;
        }
        if (!item.doc) return;
        var idx = projects.findIndex(function (project) { return project.id === item.id; });
        if (idx >= 0) projects[idx] = clone(item.doc);
        else projects.push(clone(item.doc));
        write(projects);
      });
      if (raced.length) {
        var applied = applyOps(read(), raced);
        write(applied.projects);
      }
      lastSaved = clone(read());
      return { projects: read(), pending: queue.length > 0 };
    }

    return {
      capture: capture,
      acceptRemote: acceptRemote,
      buildWrites: buildWrites,
      acknowledge: acknowledge,
      restore: restore,
      snapshot: snapshot,
      pending: function () { return queue.length > 0; },
      ops: function () { return clone(queue); },
      established: function () { return established; }
    };
  }

  return {
    PROJECT_FIELDS: PROJECT_FIELDS,
    PARTA_FIELDS: PARTA_FIELDS,
    DAY_FIELDS: DAY_FIELDS,
    LINK_FIELDS: LINK_FIELDS,
    FIELD_LABELS: FIELD_LABELS,
    clone: clone,
    stableJson: stableJson,
    diffProjects: diffProjects,
    applyOps: applyOps,
    diffRecords: diffRecords,
    mergeRecords: mergeRecords,
    syncLabel: syncLabel,
    createSyncSession: createSyncSession,
    parseTime: parseTime
  };
});
