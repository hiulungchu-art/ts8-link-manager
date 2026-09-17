/* TS8 Link Manager public config
 * Uploads use Apps Script execute-as-owner (visitors never Google-OAuth as you).
 * Firestore apiKey is public by design; protect data with Firebase Security Rules.
 */
window.TS8_CONFIG = {
  DRIVE_FOLDER_ID: '1FRJX-pH2gV_6bkv2HM9dt5S00Lmv_o2u',
  UPLOAD_WEBAPP_URL: 'https://script.google.com/macros/s/AKfycbwDF7xGONNyqMs7q2GLxj5Pls3rnFwLQSe46y-Y9j3D7M_2a1Q2RfXw0pf47Mh6X8PF/exec',
  UPLOAD_SECRET: 'ts8-upload-2026',
  FIREBASE: {
    apiKey: 'AIzaSyDTUZo4gbpp-dayC9QW3jHBP2Y7Z3UeXFI',
    authDomain: 'ts8-link-manager.firebaseapp.com',
    projectId: 'ts8-link-manager',
    storageBucket: 'ts8-link-manager.firebasestorage.app',
    messagingSenderId: '390063008080',
    appId: '1:390063008080:web:5b2f5828fdd5ddf025e455'
  }
};
