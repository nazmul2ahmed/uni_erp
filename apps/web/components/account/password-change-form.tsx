"use client";

import { AlertCircle, CheckCircle2, LoaderCircle } from "lucide-react";
import { useState } from "react";

// Mirrors the server rules (13 2.2: length >= 10; must differ from the current one) for fast feedback only.
// The server is authoritative and also proves the current password, audits failures and throttles them.
const MIN_LENGTH = 10;
const MAX_LENGTH = 128;

type Envelope = { success: boolean; error?: { code?: string; message?: string } };

export function validatePasswordChange(current: string, next: string, confirm: string): string | null {
  if (!current) return "Enter your current password";
  if (next.length < MIN_LENGTH) return `The new password must be at least ${MIN_LENGTH} characters`;
  if (next.length > MAX_LENGTH) return `The new password must be at most ${MAX_LENGTH} characters`;
  if (next === current) return "Choose a password that is different from your current one";
  if (next !== confirm) return "The new passwords do not match";
  return null;
}

export function PasswordChangeForm({ forced, onChanged }: { forced: boolean; onChanged: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const problem = validatePasswordChange(current, next, confirm);
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/auth/password/change", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: current, newPassword: next }) });
      const body = await response.json().catch(() => null) as Envelope | null;
      if (!response.ok || !body?.success) {
        if (body?.error?.code === "INVALID_CREDENTIALS") setError("Your current password is incorrect");
        else if (body?.error?.code === "RATE_LIMITED") setError("Too many incorrect attempts. Wait 15 minutes and try again.");
        else setError(body?.error?.message || "Unable to change the password");
        setBusy(false);
        return;
      }
      setCurrent(""); setNext(""); setConfirm("");
      setDone("Password changed. You were signed out of your other devices.");
      window.setTimeout(onChanged, 1200);
    } catch {
      setError("Unable to reach the server. Check your connection and try again.");
      setBusy(false);
    }
  };

  return <section className="card finance-panel payment-form" aria-labelledby="password-heading">
    <div className="card-heading"><div>
      <h2 id="password-heading">{forced ? "Set a new password" : "Change password"}</h2>
      <p>{forced ? "You signed in with a one-time password. Choose your own to continue." : `Use at least ${MIN_LENGTH} characters. Changing it signs you out everywhere else.`}</p>
    </div></div>
    <form onSubmit={submit} className="finance-form-grid">
      <label>{forced ? "One-time password" : "Current password"}<input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
      <label>New password<input type="password" autoComplete="new-password" required minLength={MIN_LENGTH} maxLength={MAX_LENGTH} value={next} onChange={(e) => setNext(e.target.value)} /></label>
      <label>Repeat new password<input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
      <div className="finance-form-action"><button className="button button-primary" disabled={busy || Boolean(done)}>{busy && <LoaderCircle className="spin" size={15} />}Change password</button></div>
    </form>
    {done && <p role="status" className="finance-empty"><CheckCircle2 size={16} /> {done}</p>}
    {error && <p className="form-error" role="alert"><AlertCircle size={16} />{error}</p>}
  </section>;
}
