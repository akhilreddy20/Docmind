'use client';

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { DocumentItem, QueryMeta, streamQuery } from '@/lib/api';

interface Message {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  meta?: QueryMeta;
  stats?: Record<string, any>;
  error?: string;
  streaming?: boolean;
}

interface Props {
  selected: Set<string>;
  docs: DocumentItem[];
  onAnswered: () => void;
}

const SUGGESTIONS = ['Summarize the key points of my documents', 'What does error code ERR-5003 mean?', 'Who owns Project Orion?'];

export default function Chat({ selected, docs, onAnswered }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const ready = docs.filter((d) => d.status === 'ready').length;

  function patch(id: number, fn: (m: Message) => Message) {
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));
  }

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    const userMsg: Message = { id: nextId.current++, role: 'user', content: question };
    const aid = nextId.current++;
    setMessages((ms) => [...ms, userMsg, { id: aid, role: 'assistant', content: '', streaming: true }]);
    setInput('');
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamQuery(
        question,
        selected.size ? Array.from(selected) : undefined,
        {
          onMeta: (meta) => patch(aid, (m) => ({ ...m, meta })),
          onToken: (t) => patch(aid, (m) => ({ ...m, content: m.content + t })),
          onDone: (stats) => patch(aid, (m) => ({ ...m, stats })),
          onError: (err) =>
            patch(aid, (m) => ({
              ...m,
              error: err.retryAfterSeconds ? `${err.message} Try again in ${err.retryAfterSeconds}s.` : err.message,
            })),
        },
        ctrl.signal,
      );
    } catch (err: any) {
      if (err.name !== 'AbortError') patch(aid, (m) => ({ ...m, error: err.message }));
    } finally {
      patch(aid, (m) => ({ ...m, streaming: false }));
      setBusy(false);
      abortRef.current = null;
      onAnswered();
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    ask(input);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask(input);
    }
  }

  return (
    <section className="chat">
      <div className="messages">
        {messages.length === 0 && (
          <div className="welcome">
            <h2>Ask your documents anything</h2>
            <p className="muted">
              {ready
                ? `Searching ${selected.size ? `${selected.size} selected` : `all ${ready}`} indexed document${ready === 1 ? '' : 's'} with hybrid BM25 + vector retrieval.`
                : 'Upload a document on the left to get started.'}
            </p>
            {ready > 0 && (
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => ask(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === 'user' ? (
              <div className="bubble">{m.content}</div>
            ) : (
              <AssistantMessage m={m} />
            )}
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <form className="composer" onSubmit={submit}>
        {selected.size > 0 && <div className="scope small">Scoped to {selected.size} selected document(s)</div>}
        <div className="composer-row">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="Ask a question… (Enter to send, Shift+Enter for newline)"
            rows={2}
            maxLength={2000}
          />
          {busy ? (
            <button type="button" className="secondary" onClick={() => abortRef.current?.abort()}>
              Stop
            </button>
          ) : (
            <button className="primary" disabled={!input.trim()}>
              Ask
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function AssistantMessage({ m }: { m: Message }) {
  const [showDebug, setShowDebug] = useState(false);
  const cache = m.meta?.cache;
  return (
    <div className="answer">
      {cache && (
        <div className="answer-tags small">
          {cache === 'miss' ? (
            <span className="tag">live answer</span>
          ) : (
            <span className="tag cache">
              {cache === 'exact' ? 'exact cache hit' : `semantic cache hit (${((m.meta?.similarity ?? 0) * 100).toFixed(1)}% similar)`}
            </span>
          )}
          {m.stats?.totalMs !== undefined && <span className="muted">{m.stats.totalMs} ms</span>}
          {m.stats?.usage && (
            <span className="muted">{m.stats.usage.promptTokens + m.stats.usage.completionTokens} tokens</span>
          )}
        </div>
      )}
      <div className="markdown">
        {m.content ? <ReactMarkdown>{m.content}</ReactMarkdown> : m.streaming && !m.error ? <span className="typing">Thinking…</span> : null}
        {m.streaming && m.content && <span className="cursor">▍</span>}
      </div>
      {m.error && <div className="error">{m.error}</div>}
      {m.meta && m.meta.sources.length > 0 && (
        <details className="sources">
          <summary>
            {m.meta.sources.length} source{m.meta.sources.length === 1 ? '' : 's'}
          </summary>
          <ol>
            {m.meta.sources.map((s) => (
              <li key={`${s.documentId}-${s.chunkIndex}`}>
                <div className="source-head small">
                  <strong>[{s.index}]</strong> {s.filename} <span className="muted">· chunk {s.chunkIndex}</span>
                </div>
                <div className="snippet small">{s.snippet}</div>
              </li>
            ))}
          </ol>
          {m.meta.retrieval && m.meta.retrieval.length > 0 && (
            <>
              <button className="link small" onClick={() => setShowDebug(!showDebug)}>
                {showDebug ? 'Hide' : 'Show'} retrieval scores
              </button>
              {showDebug && (
                <table className="debug small">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>vector rank</th>
                      <th>cosine</th>
                      <th>BM25 rank</th>
                      <th>BM25</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.meta.retrieval.map((r, i) => (
                      <tr key={i}>
                        <td>[{r.index ?? i + 1}]</td>
                        <td>{r.vectorRank ?? '—'}</td>
                        <td>{r.similarity ?? '—'}</td>
                        <td>{r.keywordRank ?? '—'}</td>
                        <td>{r.bm25 ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </details>
      )}
    </div>
  );
}
