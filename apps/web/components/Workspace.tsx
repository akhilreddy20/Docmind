'use client';

import { useCallback, useEffect, useState } from 'react';
import Chat from './Chat';
import DocumentPanel from './DocumentPanel';
import { DocumentItem, Usage, User, api } from '@/lib/api';

export default function Workspace({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);

  const loadUsage = useCallback(() => {
    api<Usage>('/query/usage').then(setUsage).catch(() => undefined);
  }, []);

  useEffect(() => {
    loadUsage();
    const t = setInterval(loadUsage, 10000);
    return () => clearInterval(t);
  }, [loadUsage]);

  const pct = usage ? Math.round((usage.llmTokens.remaining / usage.llmTokens.capacity) * 100) : null;

  return (
    <div className="workspace">
      <aside className="sidebar">
        <header className="sidebar-head">
          <div className="brand">
            <span className="logo">◆</span> DocuMind
          </div>
        </header>
        <DocumentPanel selected={selected} onSelectedChange={setSelected} onDocsChange={setDocs} />
        <footer className="sidebar-foot small">
          {usage && (
            <div className="usage" title="Per-user token bucket. Refills continuously; cache hits are free.">
              <div className="usage-label">
                <span>LLM budget</span>
                <span className="muted">
                  {usage.llmTokens.remaining.toLocaleString()} / {usage.llmTokens.capacity.toLocaleString()}
                </span>
              </div>
              <div className="progress">
                <div style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}
          <div className="account">
            <span className="muted" title={user.email}>
              {user.email}
            </span>
            <button className="link small" onClick={onLogout}>
              Sign out
            </button>
          </div>
        </footer>
      </aside>
      <main className="main">
        <Chat selected={selected} docs={docs} onAnswered={loadUsage} />
      </main>
    </div>
  );
}
