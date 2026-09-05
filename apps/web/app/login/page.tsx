"use client";

import { AlertCircle, LoaderCircle, LogIn } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Envelope<T> = { success: boolean; data?: T; error?: { message?: string } };
type Membership = { tenantId: string; tenantName: string };
type LoginResult = { memberships: Array<{ tenantId: string }>; autoSelectedTenant: string | null };

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [selectedTenant, setSelectedTenant] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      const body = await response.json() as Envelope<LoginResult>;
      if (!response.ok || !body.success || !body.data) throw new Error(body.error?.message || "Unable to sign in");
      if (body.data.autoSelectedTenant === null && body.data.memberships.length > 1) {
        const meResponse = await fetch("/api/auth/me");
        const me = await meResponse.json() as Envelope<{ memberships: Membership[] }>;
        if (!me.success || !me.data) throw new Error("Unable to load available workspaces");
        setMemberships(me.data.memberships);
        setSelectedTenant(me.data.memberships[0]?.tenantId || "");
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in");
    } finally {
      setSubmitting(false);
    }
  };

  const selectTenant = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/tenant/select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenantId: selectedTenant }) });
      const body = await response.json() as Envelope<{ activeTenantId: string }>;
      if (!response.ok || !body.success) throw new Error(body.error?.message || "Unable to select workspace");
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to select workspace");
    } finally {
      setSubmitting(false);
    }
  };

  return <main className="auth-page"><section className="auth-panel"><p className="eyebrow">LEDGERLY WORKSPACE</p><h1>{memberships.length ? "Choose a workspace" : "Sign in"}</h1><p className="page-description">{memberships.length ? "Select the business workspace you want to open." : "Use your account to continue to the business workspace."}</p>{memberships.length ? <form onSubmit={selectTenant} className="auth-form"><label>Workspace<select value={selectedTenant} onChange={(event) => setSelectedTenant(event.target.value)}>{memberships.map((membership) => <option value={membership.tenantId} key={membership.tenantId}>{membership.tenantName}</option>)}</select></label>{error && <div className="form-error" role="alert"><AlertCircle size={17} />{error}</div>}<button className="button" disabled={submitting || !selectedTenant}>{submitting ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />}{submitting ? "Opening..." : "Open workspace"}</button></form> : <form onSubmit={submit} className="auth-form"><label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{error && <div className="form-error" role="alert"><AlertCircle size={17} />{error}</div>}<button className="button" disabled={submitting}>{submitting ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />}{submitting ? "Signing in..." : "Sign in"}</button><a className="topbar-action" href="/register">Create a workspace</a></form>}</section></main>;
}