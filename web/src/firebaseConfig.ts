// Web app config from Firebase console > Project settings > Your apps.
// These values are not secret; access is protected by Firestore rules.
export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "",
  authDomain: "youtub-and-zoom-count.firebaseapp.com",
  projectId: "youtub-and-zoom-count",
  storageBucket: "youtub-and-zoom-count.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_SENDER_ID ?? "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? "",
};
