'use client';

import { DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { DocumentItem, api } from '@/lib/api';

const ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.csv,.json,.html,.htm';

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface Props {
  selected: Set<string>;
  onSelectedChange: (s: Set<string>) => void;
  onDocsChange: (docs: DocumentItem[]) => void;
}

export default function DocumentPanel({ selected, onSelectedChange, onDocsChange }: Props) {
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<{ waiting: number; active: number; workers: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api<DocumentItem[]>('/documents');
      setDocs(list);
      onDocsChange(list);
      if (list.some((d) => d.status === 'queued' || d.status === 'processing')) {
        setQueue(await api('/documents/queue/stats'));
      } else {
        setQueue(null);
      }
    } catch (err: any) {
      setError(err.message);
    }
  }, [onDocsChange]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll while anything is still being ingested by the workers.
  const pending = docs.some((d) => d.status === 'queued' || d.status === 'processing');
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [pending, refresh]);

  async function upload(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      list.forEach((f) => form.append('files', f));
      await api('/documents', { method: 'POST', body: form });
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this document and its index?')) return;
    await api(`/documents/${id}`, { method: 'DELETE' }).catch((e) => setError(e.message));
    const next = new Set(selected);
    next.delete(id);
    onSelectedChange(next);
    refresh();
  }

  async function reindex(id: string) {
    await api(`/documents/${id}/reindex`, { method: 'POST' }).catch((e) => setError(e.message));
    refresh();
  }

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    upload(e.dataTransfer.files);
  }

  return (
    <section className="docs">
      <div
        className={`dropzone ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
      >
        <input ref={input} type="file" multiple accept={ACCEPT} hidden onChange={(e) => e.target.files && upload(e.target.files)} />
        <strong>{uploading ? 'Uploading…' : 'Drop files or click to upload'}</strong>
        <span className="muted small">PDF, DOCX, TXT, MD, HTML, CSV, JSON</span>
      </div>

      {error && <div className="error small">{error}</div>}
      {queue && (
        <div className="queue small muted">
          Ingestion queue: {queue.waiting} waiting · {queue.active} active · {queue.workers} worker
          {queue.workers === 1 ? '' : 's'}
        </div>
      )}

      <div className="doc-header">
        <span>Documents ({docs.length})</span>
        {selected.size > 0 && (
          <button className="link small" onClick={() => onSelectedChange(new Set())}>
            Clear filter ({selected.size})
          </button>
        )}
      </div>

      <ul className="doc-list">
        {docs.length === 0 && <li className="muted small empty">No documents yet.</li>}
        {docs.map((d) => (
          <li key={d.id} className={selected.has(d.id) ? 'selected' : ''}>
            <label className="doc-row">
              <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} disabled={d.status !== 'ready'} />
              <span className="doc-name" title={d.filename}>
                {d.filename}
              </span>
            </label>
            <div className="doc-meta small">
              <span className={`badge ${d.status}`}>{d.status}</span>
              <span className="muted">
                {formatSize(d.sizeBytes)}
                {d.status === 'ready' && ` · ${d.chunkCount} chunks`}
              </span>
              <span className="doc-actions">
                {(d.status === 'failed' || d.status === 'ready') && (
                  <button className="link small" onClick={() => reindex(d.id)}>
                    reindex
                  </button>
                )}
                <button className="link small danger" onClick={() => remove(d.id)}>
                  delete
                </button>
              </span>
            </div>
            {(d.status === 'processing' || d.status === 'queued') && (
              <div className="progress">
                <div style={{ width: `${d.progress}%` }} />
              </div>
            )}
            {d.status === 'failed' && d.error && <div className="error small">{d.error}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}
