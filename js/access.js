/**
 * Client permission checks. Firestore rules are the real gate and are not
 * deployed from this repo automatically. REQUIRE_AUTH stays off until that
 * production change is authorized. PDF upload never sends the old public secret.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TS8Access = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var LEAKED_UPLOAD_SECRET_SHA256 = '4c3610af07a24a81964e956752c1e95737cd97c2ba3811e16f0950da705dcbe2';

  function cfg() {
    var global = typeof window !== 'undefined' ? window : globalThis;
    return (global && global.TS8_CONFIG) || {};
  }

  function authRequired() {
    return cfg().REQUIRE_AUTH === true;
  }

  function session() {
    var global = typeof window !== 'undefined' ? window : globalThis;
    if (global && global.TS8_TEST_SESSION) return global.TS8_TEST_SESSION;
    try {
      if (!global.firebase || !global.firebase.auth) return null;
      var user = global.firebase.auth().currentUser;
      if (!user) return null;
      return {
        email: user.email || '',
        emailVerified: !!user.emailVerified,
        getIdToken: function () { return user.getIdToken(); }
      };
    } catch (err) {
      return null;
    }
  }

  function emailAllowed(email) {
    var list = cfg().EDITOR_EMAILS;
    if (!Array.isArray(list) || !list.length) return true;
    var needle = String(email || '').trim().toLowerCase();
    return list.some(function (item) {
      return String(item || '').trim().toLowerCase() === needle;
    });
  }

  function signedInAllowed() {
    var current = session();
    if (!current || !current.email || current.emailVerified === false) return false;
    return emailAllowed(current.email);
  }

  function canReadWorkData() {
    if (!authRequired()) return true;
    return signedInAllowed();
  }

  function canWriteWorkData() {
    return canReadWorkData();
  }

  async function assertUploadAllowed() {
    var current = session();
    if (!current || !current.email) {
      var missing = new Error('需要登入並有權限先可以上傳 PDF');
      missing.code = 'auth';
      throw missing;
    }
    if (current.emailVerified === false) {
      var unverified = new Error('帳號電郵尚未驗證，未有上傳');
      unverified.code = 'auth';
      throw unverified;
    }
    if (!emailAllowed(current.email)) {
      var denied = new Error('此帳號沒有上傳權限，未有上傳');
      denied.code = 'auth';
      throw denied;
    }
    var token = '';
    if (typeof current.getIdToken === 'function') token = await current.getIdToken();
    if (!token) {
      var bad = new Error('登入權杖無效，未有上傳');
      bad.code = 'auth';
      throw bad;
    }
    return { idToken: token, email: current.email };
  }

  return {
    LEAKED_UPLOAD_SECRET_SHA256: LEAKED_UPLOAD_SECRET_SHA256,
    authRequired: authRequired,
    session: session,
    emailAllowed: emailAllowed,
    canReadWorkData: canReadWorkData,
    canWriteWorkData: canWriteWorkData,
    assertUploadAllowed: assertUploadAllowed
  };
});
