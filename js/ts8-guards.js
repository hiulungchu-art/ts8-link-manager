/**
 * Shared checks for PDF selection and URL rendering.
 * Validation here must run before any upload request.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TS8Guards = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PDF_MAX_BYTES = 8 * 1024 * 1024;

  function validatePdfFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (files.length !== 1) {
      return {
        ok: false,
        code: files.length ? 'multi' : 'empty',
        message: files.length
          ? '一次只可以上傳一個 PDF，未有上傳任何檔案'
          : '請選擇一個 PDF'
      };
    }
    var file = files[0];
    var name = String(file && file.name || '').toLowerCase();
    var type = String(file && file.type || '').toLowerCase();
    var typeOk = type === 'application/pdf' || name.endsWith('.pdf');
    if (!typeOk) {
      return { ok: false, code: 'type', message: '只接受 PDF 檔案，未有上傳' };
    }
    var size = Number(file && file.size);
    if (!Number.isFinite(size) || size <= 0) {
      return { ok: false, code: 'empty-file', message: 'PDF 是空檔，未有上傳' };
    }
    if (size > PDF_MAX_BYTES) {
      return { ok: false, code: 'size', message: '檔案超過 8 MB，未有上傳' };
    }
    return { ok: true, file: file };
  }

  function safeHttpUrl(value) {
    var raw = String(value == null ? '' : value).trim();
    if (!/^https?:\/\//i.test(raw)) return '';
    try {
      var url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      return url.href;
    } catch (err) {
      return '';
    }
  }

  function hkParts(date) {
    var fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Hong_Kong',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23'
    });
    var parts = {};
    fmt.formatToParts(date instanceof Date ? date : new Date(date)).forEach(function (part) {
      if (part.type !== 'literal') parts[part.type] = part.value;
    });
    return {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      ym: parts.year + '-' + parts.month
    };
  }

  return {
    PDF_MAX_BYTES: PDF_MAX_BYTES,
    validatePdfFiles: validatePdfFiles,
    safeHttpUrl: safeHttpUrl,
    hkParts: hkParts
  };
});
