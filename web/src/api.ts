import { IS_REPLAY, REPLAY_READ_ONLY_MESSAGE, replayData, replayKey } from './replay';

export class ApiError extends Error {
  readonly code: string | null;
  readonly detail: unknown;

  constructor(message: string, code: string | null = null, detail: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.detail = detail;
  }
}

async function replayRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const key = replayKey(path);
  if (method === 'GET') {
    const data = await replayData();
    if (!Object.prototype.hasOwnProperty.call(data.responses, key)) {
      throw new ApiError('Not captured in this recorded replay.', 'replay_missing');
    }
    return structuredClone(data.responses[key]) as T;
  }
  if (method === 'POST' && (key === '/api/adapters/validate' || key === '/api/adapters/preview')) {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
    try {
      const compute = await import('./replayCompute');
      return (key === '/api/adapters/validate' ? compute.computeValidate(body) : compute.computePreview(body)) as T;
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : String(error), 'invalid_request');
    }
  }
  throw new ApiError(REPLAY_READ_ONLY_MESSAGE, 'replay_read_only');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (IS_REPLAY) return replayRequest<T>(path, init);
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const record = (body ?? {}) as Record<string, unknown>;
    throw new ApiError(
      typeof record.error === 'string' ? record.error : `Request failed with HTTP ${response.status}.`,
      typeof record.code === 'string' ? record.code : null,
      record.detail ?? record.issues ?? null,
    );
  }
  return body as T;
}

export const api = {
  get<T>(path: string) {
    return request<T>(path);
  },
  post<T>(path: string, body?: unknown) {
    return request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  },
  delete<T>(path: string) {
    return request<T>(path, { method: 'DELETE' });
  },
};

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function percent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

export function shortHash(hash: string | null | undefined): string {
  if (!hash) return '—';
  return hash.slice(0, 10);
}

export function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
  return Promise.resolve();
}