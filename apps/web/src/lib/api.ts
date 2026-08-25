import { getIdToken } from './firebase.js';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/v1';

/** API base URL with the /v1 suffix. Exposed so non-JSON endpoints (e.g. file downloads) can build their own fetch. */
export function getApiBase(): string {
  return BASE;
}

/** Get a Firebase ID token for the current user, or null if not signed in.
 *  Same source the api() helper uses; exposed for direct fetch() calls. */
export { getIdToken };

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `API ${status}`);
    this.name = 'ApiError';
  }
}

export interface ApiOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Active company UUID (sent as x-kpbooks-company). */
  companyId?: string | null;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { body, companyId, headers: rawHeaders, ...rest } = opts;
  const token = await getIdToken();
  const headers = new Headers(rawHeaders);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (companyId) headers.set('x-kpbooks-company', companyId);
  if (body !== undefined) headers.set('Content-Type', 'application/json');

  const init: RequestInit = { ...rest, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, init);

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => null);
    }
    throw new ApiError(res.status, body);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Phase of an upload: bytes in flight, then the server working on them. */
export type UploadPhase = 'uploading' | 'processing';

export interface UploadProgress {
  phase: UploadPhase;
  /** 0-100. Stays at 100 through the processing phase. */
  percent: number;
  loadedBytes: number;
  totalBytes: number;
}

export interface ApiUploadOptions extends Omit<ApiOptions, 'signal'> {
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal | null | undefined;
}

/**
 * Same contract as api(), but reports upload progress.
 *
 * fetch() cannot report request-body progress — there is no upload-side
 * equivalent of a streaming response — so this uses XMLHttpRequest, which
 * exposes upload.onprogress. Everything else (auth header, company header,
 * JSON encoding, ApiError shape) matches api() so callers can swap freely.
 *
 * The bar reaches 100% when the last byte leaves the browser, but the server
 * still has to parse and commit. Without the explicit 'processing' phase a
 * large import looks frozen at 100% for many seconds, which reads as a hang,
 * so callers get a distinct phase to label instead.
 */
export function apiUpload<T>(path: string, opts: ApiUploadOptions = {}): Promise<T> {
  const { body, companyId, onProgress, signal, method = 'POST' } = opts;

  return new Promise<T>((resolve, reject) => {
    void (async () => {
      let token: string | null = null;
      try {
        token = await getIdToken();
      } catch {
        // Fall through unauthenticated; the server decides.
      }
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }

      const payload = body === undefined ? null : JSON.stringify(body);
      const xhr = new XMLHttpRequest();
      xhr.open(method, `${BASE}${path}`, true);
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      if (companyId) xhr.setRequestHeader('x-kpbooks-company', companyId);
      if (payload !== null) xhr.setRequestHeader('Content-Type', 'application/json');

      const onAbort = () => xhr.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => signal?.removeEventListener('abort', onAbort);

      const totalGuess = payload === null ? 0 : payload.length;

      xhr.upload.onprogress = (e) => {
        if (!onProgress) return;
        const total = e.lengthComputable && e.total > 0 ? e.total : totalGuess;
        const percent = total > 0 ? Math.min(99, Math.round((e.loaded / total) * 100)) : 0;
        onProgress({ phase: 'uploading', percent, loadedBytes: e.loaded, totalBytes: total });
      };

      // Bytes are gone; anything after this is the server thinking.
      xhr.upload.onload = () => {
        onProgress?.({
          phase: 'processing',
          percent: 100,
          loadedBytes: totalGuess,
          totalBytes: totalGuess,
        });
      };

      xhr.onload = () => {
        cleanup();
        const status = xhr.status;
        const raw = xhr.responseText;
        let parsed: unknown = null;
        if (raw) {
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
        }
        if (status >= 200 && status < 300) {
          resolve((status === 204 ? undefined : parsed) as T);
        } else {
          reject(new ApiError(status, parsed));
        }
      };

      xhr.onerror = () => {
        cleanup();
        // A network-layer failure gives XHR no status and no body.
        reject(new ApiError(0, null, 'Network error while uploading'));
      };
      xhr.ontimeout = () => {
        cleanup();
        reject(new ApiError(0, null, 'The upload timed out'));
      };
      xhr.onabort = () => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };

      xhr.send(payload);
    })();
  });
}
