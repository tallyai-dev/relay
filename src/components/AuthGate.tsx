'use client';
import { useEffect, useState } from 'react';
import { supabaseBrowser, hasSupabase } from '@/lib/supabase';

// Gates the app behind Supabase Auth when configured. When Supabase is not
// configured (local dev with no env), renders children directly in demo mode.
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const configured = hasSupabase();
  const [status, setStatus] = useState<'loading' | 'in' | 'out'>(configured ? 'loading' : 'in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!configured) return;
    const sb = supabaseBrowser()!;
    sb.auth.getSession().then(({ data }) => setStatus(data.session ? 'in' : 'out'));
    const { data: sub } = sb.auth.onAuthStateChange((_e, session) =>
      setStatus(session ? 'in' : 'out')
    );
    return () => sub.subscription.unsubscribe();
  }, [configured]);

  if (status === 'in') return <>{children}</>;
  if (status === 'loading') return <div className="auth-wrap"><div className="auth-card">Loading…</div></div>;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    const sb = supabaseBrowser()!;
    const fn = mode === 'signin' ? sb.auth.signInWithPassword.bind(sb.auth) : sb.auth.signUp.bind(sb.auth);
    const { error } = await fn({ email, password });
    if (error) setErr(error.message);
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-logo">R</div>
        <h1>Relay</h1>
        <p className="auth-sub">{mode === 'signin' ? 'Sign in to your book' : 'Create your account'}</p>
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {err && <div className="auth-err">{err}</div>}
        <button className="btn primary" type="submit">{mode === 'signin' ? 'Sign in' : 'Sign up'}</button>
        <button type="button" className="auth-toggle" onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
          {mode === 'signin' ? 'Need an account? Sign up' : 'Have an account? Sign in'}
        </button>
      </form>
    </div>
  );
}
