"use client";

import { AlertCircle, ArrowRight, CircleDollarSign, LoaderCircle, Package, RefreshCw, ShoppingCart, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/primitives";
import { useAccess } from "@/components/access-context";
import { can, landingPath } from "@/lib/navigation";

type Envelope<T> = { success: boolean; data?: T; error?: { message?: string } };

// Widget payloads -- shapes match apps/web/lib/dashboard/core-widgets.ts.
type SalesData = {
  summary: { transactionCount: number; grossSales: string; paidSales: string; outstandingSales: string };
  trend: Array<{ date: string; total: string; transactionCount: number }>;
  topItems: Array<{ itemId: string; itemName: string; sku: string | null; quantity: string; revenue: string }>;
};
type StockData = {
  lowStockCount: number;
  outOfStockCount: number;
  items: Array<{ itemId: string; itemName: string; sku: string | null; threshold: string | null; onHand: string; reserved: string; available: string; isLowStock: boolean }>;
};
type CashData = { cash: string; bank: string };
type ReceivablesData = { receivables: string };
type PayablesData = { payables: string };
type ProfitData = {
  revenue: { total: string };
  cogs: { total: string };
  grossProfit: string;
  operatingExpenses: { lines: Array<{ code: string; name: string; amount: string }>; total: string };
  netProfit: string;
};

// Decision RPT-002: the server returns only the widgets this actor may see
// (12 s8). The page renders whatever is present and contains no
// industry/module/permission branching of its own.
type Dashboard = {
  generatedAt: string;
  currency: string;
  widgets: Array<{ key: string; title: string; data: unknown }>;
};

function widgetData<T>(dashboard: Dashboard, key: string): T | null {
  const found = dashboard.widgets.find((widget) => widget.key === key);
  return found ? (found.data as T) : null;
}

const money = (value: string, currency: string) => `${currency} ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function loadDashboard(): Promise<Dashboard> {
  const response = await fetch("/api/reports/dashboard");
  const body = await response.json() as Envelope<Dashboard>;
  if (!response.ok || !body.success || !body.data) throw new Error(body.error?.message || "Unable to load dashboard data");
  return body.data;
}

export default function DashboardPage() {
  const access = useAccess();
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await loadDashboard());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load dashboard data");
    } finally {
      setLoading(false);
    }
  }, []);
  // Decision NAV-001: don't fire a request the server will refuse; explain and point to the user's own landing page.
  const denied = access.ready && access.permissions !== null && !can(access.permissions, "reports.view");
  useEffect(() => { if (access.ready && !denied) void load(); }, [load, denied, access.ready]); // wait for /me so a restricted role never sees a flash of server error

  if (denied) {
    const home = landingPath(access.permissions);
    return <main className="page-content dashboard-page"><div className="inline-empty" role="status"><AlertCircle size={22} /><strong>The dashboard isn&apos;t available for your role</strong><p>Ask a workspace owner if you need access to dashboard reports.</p>{home !== "/dashboard" && <a className="button button-primary" href={home}>Go to your workspace <ArrowRight size={15} /></a>}</div></main>;
  }
  if (loading) return <main className="page-content dashboard-page"><div className="finance-loading"><LoaderCircle className="spin" size={22} />Loading dashboard</div></main>;
  if (error || !data) return <main className="page-content dashboard-page"><div className="inline-error" role="alert"><AlertCircle size={22} /><strong>Dashboard data is unavailable</strong><p>{error || "No dashboard data was returned."}</p><button className="button button-outline" onClick={() => void load()}><RefreshCw size={15} />Try again</button></div></main>;

  const sales = widgetData<SalesData>(data, "sales-summary");
  const stock = widgetData<StockData>(data, "low-stock");
  const cash = widgetData<CashData>(data, "cash-position");
  const receivables = widgetData<ReceivablesData>(data, "receivables-due");
  const payables = widgetData<PayablesData>(data, "payables-due");
  const profit = widgetData<ProfitData>(data, "profit-snapshot");

  return <main className="page-content dashboard-page">
    <div className="executive-hero">
      <div className="executive-copy"><p className="eyebrow">OPERATIONS OVERVIEW</p><h1>Executive dashboard</h1><p className="page-description">Authoritative sales, finance, and stock signals for the active workspace.</p></div>
      <div className="executive-summary">
        <span className="summary-pill success">Live</span>
        {sales && <><div className="summary-block"><small>Sales in period</small><strong>{money(sales.summary.grossSales, data.currency)}</strong></div><div className="summary-block muted"><small>Transactions</small><strong>{sales.summary.transactionCount}</strong></div></>}
      </div>
      <div className="dashboard-header-actions"><button className="button button-outline" onClick={() => void load()}><RefreshCw size={15} />Refresh</button><a className="button" href="/reports">View reports <ArrowRight size={15} /></a></div>
    </div>

    <div className="dashboard-grid">
      {sales && <Metric label="Sales" value={money(sales.summary.grossSales, data.currency)} delta={`${sales.summary.transactionCount} posted transactions`} icon={CircleDollarSign} tone="green" />}
      {receivables && <Metric label="Customer receivables" value={money(receivables.receivables, data.currency)} delta="Open ledger balance" icon={Users} tone="blue" />}
      {payables && <Metric label="Supplier payables" value={money(payables.payables, data.currency)} delta="Open ledger balance" icon={ShoppingCart} tone="amber" />}
      {stock && <Metric label="Available stock alerts" value={`${stock.lowStockCount}`} delta={`${stock.outOfStockCount} out of stock`} icon={Package} tone="slate" />}
    </div>

    {(sales || stock) && <div className="dashboard-lower">
      {sales && <Card className="activity-card">
        <div className="card-heading"><div><h2>Sales trend</h2><p>Server-side daily totals</p></div><a className="text-button" href="/reports">View report <ArrowRight size={15} /></a></div>
        {sales.trend.length === 0
          ? <div className="inline-empty"><strong>No sales in this period</strong><p>Posted sales will appear here once available.</p></div>
          : <>
            <div className="trend-chart" aria-label="Sales trend chart"><TrendBars rows={sales.trend} /></div>
            <div className="report-table-alternative"><table><caption className="sr-only">Sales trend values</caption><thead><tr><th>Date</th><th>Transactions</th><th>Total</th></tr></thead><tbody>{sales.trend.map((row) => <tr key={row.date}><td>{row.date}</td><td>{row.transactionCount}</td><td className="numeric">{money(row.total, data.currency)}</td></tr>)}</tbody></table></div>
          </>}
      </Card>}
      {stock && <Card className="setup-card">
        <div className="card-heading"><div><h2>Stock attention</h2><p>Derived from current stock balances</p></div></div>
        {stock.items.filter((item) => item.isLowStock).slice(0, 5).map((item) => <div className="compact-item" key={item.itemId}><div><strong>{item.itemName}</strong><small>{item.sku || "No SKU"}</small></div><span>{item.available} available</span></div>)}
        {stock.lowStockCount === 0 && <div className="inline-empty"><strong>Stock looks healthy</strong><p>No configured low-stock thresholds are currently breached.</p></div>}
      </Card>}
    </div>}

    {(sales || cash || profit) && <div className="dashboard-lower dashboard-lower-secondary">
      {sales && <Card className="activity-card">
        <div className="card-heading"><div><h2>Top selling items</h2><p>Revenue from posted sales</p></div></div>
        {sales.topItems.length === 0
          ? <p className="finance-empty">No posted item sales found.</p>
          : <div className="compact-list">{sales.topItems.slice(0, 5).map((item) => <div className="compact-item" key={item.itemId}><div><strong>{item.itemName}</strong><small>{item.quantity} units</small></div><span>{money(item.revenue, data.currency)}</span></div>)}</div>}
      </Card>}
      {profit && <Card className="activity-card">
        <div className="card-heading"><div><h2>Profit snapshot</h2><p>From posted journals in the selected period</p></div></div>
        <div className="compact-list">
          <div className="compact-item"><strong>Revenue</strong><span>{money(profit.revenue.total, data.currency)}</span></div>
          <div className="compact-item"><strong>Cost of goods sold</strong><span>{money(profit.cogs.total, data.currency)}</span></div>
          <div className="compact-item"><strong>Gross profit</strong><span>{money(profit.grossProfit, data.currency)}</span></div>
          <div className="compact-item"><strong>Operating expenses</strong><span>{money(profit.operatingExpenses.total, data.currency)}</span></div>
          <div className="compact-item"><strong>Net profit</strong><span>{money(profit.netProfit, data.currency)}</span></div>
        </div>
      </Card>}
      {cash && <Card className="activity-card">
        <div className="card-heading"><div><h2>Cash position</h2><p>Accounting balances from posted journals</p></div></div>
        <div className="compact-list"><div className="compact-item"><strong>Cash</strong><span>{money(cash.cash, data.currency)}</span></div><div className="compact-item"><strong>Bank</strong><span>{money(cash.bank, data.currency)}</span></div></div>
      </Card>}
    </div>}

    <p className="report-generated">Generated {new Date(data.generatedAt).toLocaleString()}</p>
  </main>;
}

function Metric({ label, value, delta, icon: Icon, tone }: { label: string; value: string; delta: string; icon: typeof CircleDollarSign; tone: string }) {
  return <Card className="metric-card"><div className="metric-topline"><div className={`metric-icon metric-${tone}`}><Icon size={18} /></div><span className="metric-badge">Authoritative</span></div><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><span className="metric-change">{delta}</span></Card>;
}

function TrendBars({ rows }: { rows: SalesData["trend"] }) {
  const maximum = Math.max(...rows.map((row) => Number(row.total)), 1);
  return <>{rows.map((row) => <div className="trend-bar-wrap" key={row.date}><span className="trend-bar" style={{ height: `${Math.max((Number(row.total) / maximum) * 100, 8)}%` }} title={`${row.date}: ${row.total}`} /><small>{row.date.slice(5)}</small></div>)}</>;
}
