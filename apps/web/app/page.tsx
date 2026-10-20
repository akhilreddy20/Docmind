'use client';

import { useEffect, useState } from 'react';
import AuthForm from '@/components/AuthForm';
import Workspace from '@/components/Workspace';
import { User, session } from '@/lib/api';

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setUser(session.token ? session.user : null);
    setReady(true);
    const onLogout = () => setUser(null);
    window.addEventListener('documind:logout', onLogout);
    return () => window.removeEventListener('documind:logout', onLogout);
  }, []);

  if (!ready) return null;
  if (!user) return <AuthForm onAuthed={setUser} />;
  return (
    <Workspace
      user={user}
      onLogout={() => {
        session.clear();
        setUser(null);
      }}
    />
  );
}
