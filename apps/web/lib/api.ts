export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const TOKEN_KEY = 'documind.token';
const USER_KEY = 'documind.user';

export interface User {
  id: string;
  email: string;
}

export interface DocumentItem {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  progress: number;
  error: string | null;
  chunkCount: number;
  createdAt: string;
}

export interface Source {
  index: number;
  documentId: string;
  filename: string;
  chunkIndex: number;
  snippet: string;
}

export interface RetrievalDebug {
  index?: number;
  vectorRank: number | null;
  keywordRank: number | null;
  similarity: number | null;
  bm25: number | null;
}

export interface QueryMeta {
  cache: 'exact' | 'semantic' | 'miss';
  similarity?: number;
  sources: Source[];
  retrieval?: RetrievalDebug[];
}

export interface Usage {
  llmTokens: { remaining: number; capacity: number; refillPerSec: number };
  requests: { remaining: number; capacity: number; refillPerSec: number };
  semanticCacheMode: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public retryAfterSeconds?: number | null) {
    super(message);
  }
}

export const session = {
  get token() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  get user(): User | null {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  save(token: string, user: User) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch {
      /* storage unavailable: session lasts for this tab only */
    }
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch {
      /* ignore */
    }
  },
};

async function toError(res: Response): Promise<ApiError> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  const msg = Array.isArray(body?.message) ? body.message.join(', ') : body?.message ?? res.statusText;
  return new ApiError(res.status, msg, body?.retryAfterSeconds);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = session.token;
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (res.status === 401 && token) {
    session.clear();
    window.dispatchEvent(new Event('documind:logout'));
  }
  if (!res.ok) throw await toError(res);
  return res.json();
}

export interface StreamHandlers {
  onMeta(meta: QueryMeta): void;
  onToken(text: string): void;
  onDone(data: Record<string, any>): void;
  onError(err: ApiError): void;
}

/**
 * POST + Server-Sent Events. EventSource only supports GET without headers,
 * so we read the text/event-stream body from fetch and parse frames ourselves.
 */
export async function streamQuery(
  question: string,
  documentIds: string[] | undefined,
  h: StreamHandlers,
  signal: AbortSignal,
) {
  const res = await fetch(`${API_URL}/query/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({ question, documentIds: documentIds?.length ? documentIds : undefined }),
    signal,
  });
  if (!res.ok || !res.body) {
    h.onError(await toError(res));
    return;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith(':')) continue; // heartbeat comment
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue;
      const payload = JSON.parse(data.join('\n'));
      if (event === 'meta') h.onMeta(payload);
      else if (event === 'token') h.onToken(payload);
      else if (event === 'done') h.onDone(payload);
      else if (event === 'error') h.onError(new ApiError(payload.statusCode ?? 500, payload.message ?? 'Stream error', payload.retryAfterSeconds));
    }
  }
}
