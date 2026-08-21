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
  const [mode, setMode] = useState<'signin' | 'signup' | 'forgot'>('signin');
  const [sending, setSending] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [recovering, setRecovering] = useState(false); // arrived via a set-password link
  const [notice, setNotice] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!configured) return;
    const sb = supabaseBrowser()!;
    sb.auth.getSession().then(({ data }) => setStatus(data.session ? 'in' : 'out'));
    const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
      // An invite / reset link fires PASSWORD_RECOVERY — hold the app and show
      // the "set your password" form instead of dropping them straight in.
      if (event === 'PASSWORD_RECOVERY') { setRecovering(true); setStatus('out'); return; }
      setStatus(session ? 'in' : 'out');
    });
    return () => sub.subscription.unsubscribe();
  }, [configured]);

  if (status === 'in') return <>{children}</>;
  if (status === 'loading') return <div className="auth-wrap"><div className="auth-card">Loading…</div></div>;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(''); setNotice('');
    const sb = supabaseBrowser()!;
    if (mode === 'forgot') {
      setSending(true);
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
      setSending(false);
      if (error) { setErr(error.message); return; }
      setNotice(`Reset link sent to ${email} — check your inbox (and spam), then follow the link to set a new password.`);
      setMode('signin');
      return;
    }
    // Bind so the Supabase auth method keeps its `this` when called via `fn`.
    const fn = mode === 'signin' ? sb.auth.signInWithPassword.bind(sb.auth) : sb.auth.signUp.bind(sb.auth);
    const { error } = await fn({ email, password });
    if (error) {
      // The stock message reads like a system fault — point at the fix instead.
      setErr(error.message === 'Invalid login credentials'
        ? 'That email + password combo didn’t match. Double-check it, or use “Forgot password?” below to set a new one.'
        : error.message);
    }
  };

  const setNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (password.length < 8) { setErr('Use at least 8 characters.'); return; }
    const sb = supabaseBrowser()!;
    const { error } = await sb.auth.updateUser({ password });
    if (error) { setErr(error.message); return; }
    setRecovering(false);
    setNotice('Password set — you can sign in now.');
    setMode('signin');
    setPassword('');
  };

  if (recovering) {
    return (
      <div className="auth-wrap">
        <form className="auth-card" onSubmit={setNewPassword}>
          <div className="auth-logo">R</div>
          <h1>Set your password</h1>
          <p className="auth-sub">Choose a password to finish setting up your Relay account.</p>
          <label>New password
            <div className="pw-wrap">
              <input type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button type="button" className="pw-eye" tabIndex={-1} onClick={() => setShowPw((v) => !v)}>{showPw ? 'Hide' : 'Show'}</button>
            </div>
          </label>
          {err && <div className="auth-err">{err}</div>}
          <button className="btn primary" type="submit">Save password</button>
        </form>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-logo">R</div>
        <h1>Relay</h1>
        <p className="auth-sub">{mode === 'signin' ? 'Sign in to your book' : mode === 'signup' ? 'Create your account' : 'Enter your email and we’ll send you a link to set a new password.'}</p>
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        {mode !== 'forgot' && (
          <label>Password
            <div className="pw-wrap">
              <input type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button type="button" className="pw-eye" tabIndex={-1} onClick={() => setShowPw((v) => !v)}>{showPw ? 'Hide' : 'Show'}</button>
            </div>
          </label>
        )}
        {notice && <div className="auth-note">{notice}</div>}
        {err && <div className="auth-err">{err}</div>}
        <button className="btn primary" type="submit" disabled={sending}>
          {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Sign up' : sending ? 'Sending…' : 'Email me a reset link'}
        </button>
        {mode === 'signin' && (
          <button type="button" className="auth-toggle" onClick={() => { setErr(''); setNotice(''); setMode('forgot'); }}>Forgot password?</button>
        )}
        <button type="button" className="auth-toggle" onClick={() => { setErr(''); setNotice(''); setMode(mode === 'signin' ? 'signup' : 'signin'); }}>
          {mode === 'signin' ? 'Need an account? Sign up' : mode === 'forgot' ? '← Back to sign in' : 'Have an account? Sign in'}
        </button>
      </form>
    </div>
  );
}
