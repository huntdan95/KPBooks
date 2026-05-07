import { getIdToken } from './firebase.js';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/v1';

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
