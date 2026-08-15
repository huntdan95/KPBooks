import { type FirebaseApp, initializeApp } from 'firebase/app';
import {
  type Auth,
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  setPersistence,
  signInWithPopup,
  signOut as fbSignOut,
} from 'firebase/auth';

/**
 * Firebase web config is loaded from VITE_FIREBASE_* env vars. These values are
 * not secrets — Google designed them to be embedded in client bundles. The real
 * secrets (Admin SDK service-account JSON) live server-side only.
 */
// Committed fallbacks: a build on a machine without apps/web/.env used to
// bake `undefined` into the bundle, making initializeApp throw at load and
// blank-screen the deployed site. Env vars still override when present
// (e.g. pointing a build at a staging project).
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? 'AIzaSyAd3oH6Yzpm5lL0Uzxkmnl9zlylLhPuQ6g',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? 'kpbooks-91c48.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'kpbooks-91c48',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? 'kpbooks-91c48.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '207649309602',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '1:207649309602:web:dbdf1dc63d27ac5b0968fb',
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID ?? 'G-Q1ZZSMRJYG',
};

export const firebaseApp: FirebaseApp = initializeApp(firebaseConfig);
export const auth: Auth = getAuth(firebaseApp);
void setPersistence(auth, browserLocalPersistence);
export const googleProvider = new GoogleAuthProvider();

export async function getIdToken(): Promise<string | null> {
  const user = auth.currentUser;
  if (!user) return null;
  return user.getIdToken();
}

export async function signInWithGoogle(): Promise<void> {
  await signInWithPopup(auth, googleProvider);
}

export async function signOut(): Promise<void> {
  await fbSignOut(auth);
}
