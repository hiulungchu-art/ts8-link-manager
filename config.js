/* TS8 Link Manager public config
 * The Firebase apiKey is a public client identifier. Restrict it by HTTP
 * referrer in Google Cloud, and protect documents with firestore.rules.
 * Those rules are NOT deployed by this repo.
 *
 * Do not put upload secrets, admin passwords, or service-account keys here.
 * PDF upload requires a signed-in Firebase user and does not use a shared secret.
 * REQUIRE_AUTH stays false so daily link editing keeps working until Google
 * sign-in and firestore.rules are turned on in production.
 * Apps Script is not a write source while Firebase is configured.
 */
window.TS8_CONFIG = {
  UPLOAD_WEBAPP_URL: 'https://script.google.com/macros/s/AKfycbwDF7xGONNyqMs7q2GLxj5Pls3rnFwLQSe46y-Y9j3D7M_2a1Q2RfXw0pf47Mh6X8PF/exec',
  FIREBASE: {
    apiKey: 'AIzaSyDTUZo4gbpp-dayC9QW3jHBP2Y7Z3UeXFI',
    authDomain: 'ts8-link-manager.firebaseapp.com',
    projectId: 'ts8-link-manager',
    storageBucket: 'ts8-link-manager.firebasestorage.app',
    messagingSenderId: '390063008080',
    appId: '1:390063008080:web:5b2f5828fdd5ddf025e455'
  },
  REQUIRE_AUTH: false,
  EDITOR_EMAILS: [],
  ALLOW_LEGACY_SYNC: false
};
