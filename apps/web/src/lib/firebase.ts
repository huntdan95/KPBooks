import { type FirebaseApp, initializeApp } from 'firebase/app';
import {
  type Auth,
  type UserCredential,
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  getRedirectResult,
  setPersistence,
  signInWithPopup,
  signInWithRedirect,
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
/**
 * Firebase stashes sign-in state in sessionStorage on the authDomain. When the
 * authDomain is a different origin from the page, iOS Safari's storage
 * partitioning (ITP) hides that state on the way back and the auth handler
 * dies with auth/missing-initial-state — the iPhone sign-up failure.
 *
 * Serving the app from kpbooks-91c48.firebaseapp.com makes app origin and
 * authDomain identical, which sidesteps the problem entirely.
 *
 * kpbooks-91c48.web.app CANNOT be used as authDomain until
 * https://kpbooks-91c48.web.app/__/auth/handler is added to the OAuth client's
 * authorized redirect URIs in Google Cloud Console — Google currently rejects
 * that redirect_uri, which would break sign-in everywhere.
 */
const SAME_ORIGIN_AUTH_DOMAINS = new Set(['kpbooks-91c48.firebaseapp.com']);

function resolveAuthDomain(fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const host = window.location.hostname;
  return SAME_ORIGIN_AUTH_DOMAINS.has(host) ? host : fallback;
}

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? 'AIzaSyAd3oH6Yzpm5lL0Uzxkmnl9zlylLhPuQ6g',
  authDomain: resolveAuthDomain(
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? 'kpbooks-91c48.firebaseapp.com',
  ),
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

/**
 * Mobile Safari opens an OAuth popup as a SEPARATE TAB, and sessionStorage is
 * per-tab — so the state Firebase wrote before leaving can be gone when the
 * flow returns, surfacing as auth/missing-initial-state. Redirect keeps the
 * whole exchange in one tab, which is what Firebase recommends for mobile.
 */
function prefersRedirect(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  const iOS =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports as MacIntel; touch points disambiguate it.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return iOS || /Android/.test(ua) || window.matchMedia('(pointer: coarse)').matches;
}

// Popup failures worth retrying as a redirect. Deliberately EXCLUDES
// popup-closed-by-user and cancelled-popup-request: the user dismissed it on
// purpose, and force-navigating them would be hostile.
const POPUP_FALLBACK_CODES = new Set([
  'auth/popup-blocked',
  'auth/operation-not-supported-in-this-environment',
  'auth/missing-initial-state',
  'auth/web-storage-unsupported',
]);

export async function signInWithGoogle(): Promise<void> {
  if (prefersRedirect()) {
    await signInWithRedirect(auth, googleProvider);
    return;
  }
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code && POPUP_FALLBACK_CODES.has(code)) {
      await signInWithRedirect(auth, googleProvider);
      return;
    }
    throw err;
  }
}

/**
 * Completes a redirect sign-in. Returns null on a normal page load; throws the
 * underlying FirebaseError if the redirect came back broken, so the sign-in
 * screen can show a real message instead of silently returning to a button.
 */
export async function consumeRedirectResult(): Promise<UserCredential | null> {
  return getRedirectResult(auth);
}

export async function signOut(): Promise<void> {
  await fbSignOut(auth);
}
