"use client";

import { AlertCircle, LoaderCircle, LogOut, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/primitives";

// Platform Integration Contract v1 (Plan/31). This page is a CLIENT of the contract: it reads only
// /api/platform/v1/* and knows nothing about the database, so a separate platform console can
// replace it without touching the application.
type Envelope<T> = { success: boolean; data?: T; error?: { code?: string; message?: string } };
type Overview = {
  contractVersion: string;
  app: { id: string; name: string; version: string };
  generatedAt: string;
  data: {
    tenants: {
      total: number;
      byStatus: Record<string, number>;
      byStorageMode: Record<string, number>;
      recent: Array<{ id: string; name: string; status: string; storageMode: string; createdAt: string }>;
    };
    featureAdoption: Array<{ featureKey: string; enabled: number; configured: number }>;
    users: { active: number };
  };
};

class LoadError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

async function loadOverview(): Promise<Overview> {
  const response = await fetch("/api/platform/v1/overview");
  const body = await response.json().catch(() => null) as Envelope<Overview> | null;
  if (!response.ok || !body?.success || !body.data) {
    // Decision SEC-008: a CLI-issued one-time password may only be changed -- go straight to the change page.
    if (body?.error?.code === "PASSWORD_CHANGE_REQUIRED") { window.location.replace("/platform/account?required=1"); }
    throw new LoadError(body?.error?.message || "Unable to load platform data", response.status, body?.error?.code);
  }
  return body.data;
}

const EXPLANATION: Record<number, string> = {
  401: "Sign in with a platform operator account to continue.",
  403: "This account is not a platform operator.",
  404: "Platform administration is not available here: it is either switched off for this deployment or not reachable from your network.",
};

export default function PlatformPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setOverview(await loadOverview()); }
    catch (err) { setError(err instanceof LoadError ? err : new LoadError("Unable to load platform data", 0)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  };

  const shell = (content: React.ReactNode) => <div className="app-main" style={{ minHeight: "100vh" }}>
    <header className="app-topbar">
      <span className="topbar-context">Platform administration{overview && <small>  {overview.app.name} · contract {overview.contractVersion}</small>}</span>
      <div className="topbar-user"><a className="topbar-action" href="/platform/account">Password</a><button className="topbar-action" onClick={() => void signOut()}><LogOut size={15} />Sign out</button></div>
    </header>
    {content}
  </div>;

  if (loading && !overview) return shell(<main className="page-content"><div className="finance-loading"><LoaderCircle className="spin" size={22} />Loading platform data</div></main>);
  if (error || !overview) {
    const status = error?.status ?? 0;
    return shell(<main className="page-content"><div className="inline-error" role="alert"><AlertCircle size={22} /><strong>Platform data is unavailable</strong><p>{EXPLANATION[status] ?? error?.message ?? "Unable to load platform data."}</p>{status === 401 ? <a className="button button-primary" href="/login">Sign in</a> : <button className="button button-outline" onClick={() => void load()}><RefreshCw size={15} />Try again</button>}</div></main>);
  }

  const { tenants, featureAdoption, users } = overview.data;
  return shell(<main className="page-content dashboard-page">
    <div className="executive-hero">
      <div className="executive-copy"><p className="eyebrow">CONTROL PLANE</p><h1>Platform overview</h1><p className="page-description">Aggregate figures across all workspaces. No workspace business data is shown or accessible from here.</p></div>
      <div className="executive-summary"><span className="summary-pill success">Read-only</span><div className="summary-block"><small>Workspaces</small><strong>{tenants.total}</strong></div><div className="summary-block muted"><small>Active users</small><strong>{users.active}</strong></div></div>
      <div className="dashboard-header-actions"><button className="button button-outline" onClick={() => void load()}><RefreshCw size={15} />Refresh</button></div>
    </div>

    <div className="dashboard-lower">
      <Card className="activity-card">
        <div className="card-heading"><div><h2>Workspaces by status</h2><p>Lifecycle state of every workspace</p></div></div>
        <div className="table-scroll"><table><thead><tr><th>Status</th><th>Workspaces</th></tr></thead><tbody>{Object.entries(tenants.byStatus).map(([status, count]) => <tr key={status}><td>{status}</td><td className="numeric">{count}</td></tr>)}</tbody></table></div>
      </Card>
      <Card className="activity-card">
        <div className="card-heading"><div><h2>Storage model</h2><p>Shared database vs dedicated database</p></div></div>
        <div className="table-scroll"><table><thead><tr><th>Mode</th><th>Workspaces</th></tr></thead><tbody>{Object.entries(tenants.byStorageMode).map(([mode, count]) => <tr key={mode}><td>{mode}</td><td className="numeric">{count}</td></tr>)}</tbody></table></div>
      </Card>
    </div>

    <div className="dashboard-lower dashboard-lower-secondary">
      <Card className="activity-card">
        <div className="card-heading"><div><h2>Recently created workspaces</h2><p>Latest {tenants.recent.length}</p></div></div>
        <div className="table-scroll"><table><thead><tr><th>Name</th><th>Status</th><th>Storage</th><th>Created</th></tr></thead><tbody>{tenants.recent.map((t) => <tr key={t.id}><td>{t.name}</td><td>{t.status}</td><td>{t.storageMode}</td><td>{new Date(t.createdAt).toLocaleDateString()}</td></tr>)}</tbody></table></div>
        {tenants.recent.length === 0 && <p className="finance-empty">No workspaces yet.</p>}
      </Card>
      <Card className="activity-card">
        <div className="card-heading"><div><h2>Feature adoption</h2><p>Workspaces with each optional module enabled</p></div></div>
        {featureAdoption.length === 0 ? <p className="finance-empty">No optional modules have been configured by any workspace.</p> : <div className="table-scroll"><table><thead><tr><th>Feature</th><th>Enabled</th><th>Configured</th></tr></thead><tbody>{featureAdoption.map((f) => <tr key={f.featureKey}><td>{f.featureKey}</td><td className="numeric">{f.enabled}</td><td className="numeric">{f.configured}</td></tr>)}</tbody></table></div>}
      </Card>
    </div>

    <p className="report-generated">Generated {new Date(overview.generatedAt).toLocaleString()}. Workspace health, subscription plans and cost figures will appear when their data sources are built.</p>
  </main>);
}
