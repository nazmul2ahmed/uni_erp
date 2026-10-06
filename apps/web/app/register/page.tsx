"use client";

import { AlertCircle, LoaderCircle, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Envelope<T> = { success: boolean; data?: T; error?: { message?: string } };

type FormState = { fullName: string; email: string; password: string; businessName: string };

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>({ fullName: "", email: "", password: "", businessName: "" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const update = (field: keyof FormState, value: string) => setForm((current) => ({ ...current, [field]: value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const body = await response.json() as Envelope<{ userId: string; tenantId: string }>;
      if (!response.ok || !body.success) throw new Error(body.error?.message || "Unable to create account");
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create account");
    } finally {
      setSubmitting(false);
    }
  };

  return <main className="auth-page"><section className="auth-panel"><p className="eyebrow">LEDGERLY WORKSPACE</p><h1>Create your workspace</h1><p className="page-description">Register an owner account and start a business workspace.</p><form onSubmit={submit} className="auth-form"><label>Full name<input autoComplete="name" value={form.fullName} onChange={(event) => update("fullName", event.target.value)} required /></label><label>Business name<input autoComplete="organization" value={form.businessName} onChange={(event) => update("businessName", event.target.value)} required /></label><label>Email<input type="email" autoComplete="email" value={form.email} onChange={(event) => update("email", event.target.value)} required /></label><label>Password<input type="password" autoComplete="new-password" minLength={10} value={form.password} onChange={(event) => update("password", event.target.value)} required /><small className="page-description">Use at least 10 characters.</small></label>{error && <div className="form-error" role="alert"><AlertCircle size={17} />{error}</div>}<button className="button" disabled={submitting}>{submitting ? <LoaderCircle className="spin" size={16} /> : <UserPlus size={16} />}{submitting ? "Creating workspace..." : "Create workspace"}</button><a className="topbar-action" href="/login">Already have an account? Sign in</a></form></section></main>;
}
