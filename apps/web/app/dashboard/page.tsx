"use client";

import { AlertCircle, ArrowRight, CircleDollarSign, LoaderCircle, Package, RefreshCw, ShoppingCart, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/primitives";

type Envelope<T> = { success: boolean; data?: T; error?: { message?: string } };
type Dashboard = {
  generatedAt: string;
  currency: string;
  sales: { summary: { transactionCount: number; grossSales: string; paidSales: string; outstandingSales: string }; trend: Array<{ date: string; total: string; transactionCount: number }>; topItems: Array<{ itemId: string; itemName: string; sku: string | null; quantity: string; revenue: string }> };
  stock: { lowStockCount: number; outOfStockCount: number; items: Array<{ itemId: string; itemName: string; sku: string | null; threshold: string | null; onHand: string; reserved: string; available: string; isLowStock: boolean }> };
  finance: { receivables: string; payables: string; cash: string; bank: string };
};

const money = (value: string, currency: string) => `${currency} ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function loadDashboard(): Promise<Dashboard> {
  const response = await fetch("/api/reports/dashboard");
  const body = await response.json() as Envelope<Dashboard>;
  if (!response.ok || !body.success || !body.data) throw new Error(body.error?.message || "Unable to load dashboard data");
  return body.data;
}

export default function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { setLoading(true); setError(null); try { setData(await loadDashboard()); } catch (err) { setError(err instanceof Error ? err.message : "Unable to load dashboard data"); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);

  if (loading) return <main className="page-content dashboard-page"><div className="finance-loading"><LoaderCircle className="spin" size={22} />Loading dashboard</div></main>;
  if (error || !data) return <main className="page-content dashboard-page"><div className="inline-error" role="alert"><AlertCircle size={22} /><strong>Dashboard data is unavailable</strong><p>{error || "No dashboard data was returned."}</p><button className="button button-outline" onClick={() => void load()}><RefreshCw size={15} />Try again</button></div></main>;

  const { sales, stock, finance } = data;
  return <main className="page-content dashboard-page">
    <div className="executive-hero"><div className="executive-copy"><p className="eyebrow">OPERATIONS OVERVIEW</p><h1>Executive dashboard</h1><p className="page-description">Authoritative sales, finance, and stock signals for the active workspace.</p></div><div className="executive-summary"><span className="summary-pill success">Live</span><div className="summary-block"><small>Sales in period</small><strong>{money(sales.summary.grossSales, data.currency)}</strong></div><div className="summary-block muted"><small>Transactions</small><strong>{sales.summary.transactionCount}</strong></div></div><div className="dashboard-header-actions"><button className="button button-outline" onClick={() => void load()}><RefreshCw size={15} />Refresh</button><a className="button" href="/reports">View reports <ArrowRight size={15} /></a></div></div>
    <div className="dashboard-grid"><Metric label="Sales" value={money(sales.summary.grossSales, data.currency)} delta={`${sales.summary.transactionCount} posted transactions`} icon={CircleDollarSign} tone="green" /><Metric label="Customer receivables" value={money(finance.receivables, data.currency)} delta="Open ledger balance" icon={Users} tone="blue" /><Metric label="Supplier payables" value={money(finance.payables, data.currency)} delta="Open ledger balance" icon={ShoppingCart} tone="amber" /><Metric label="Available stock alerts" value={`${stock.lowStockCount}`} delta={`${stock.outOfStockCount} out of stock`} icon={Package} tone="slate" /></div>
    <div className="dashboard-lower"><Card className="activity-card"><div className="card-heading"><div><h2>Sales trend</h2><p>Server-side daily totals</p></div><a className="text-button" href="/reports">View report <ArrowRight size={15} /></a></div>{sales.trend.length === 0 ? <div className="inline-empty"><strong>No sales in this period</strong><p>Posted sales will appear here once available.</p></div> : <><div className="trend-chart" aria-label="Sales trend chart"><TrendBars rows={sales.trend} /></div><div className="report-table-alternative"><table><caption className="sr-only">Sales trend values</caption><thead><tr><th>Date</th><th>Transactions</th><th>Total</th></tr></thead><tbody>{sales.trend.map((row) => <tr key={row.date}><td>{row.date}</td><td>{row.transactionCount}</td><td className="numeric">{money(row.total, data.currency)}</td></tr>)}</tbody></table></div></>}</Card><Card className="setup-card"><div className="card-heading"><div><h2>Stock attention</h2><p>Derived from current stock balances</p></div></div>{stock.items.filter((item) => item.isLowStock).slice(0, 5).map((item) => <div className="compact-item" key={item.itemId}><div><strong>{item.itemName}</strong><small>{item.sku || "No SKU"}</small></div><span>{item.available} available</span></div>)}{stock.lowStockCount === 0 && <div className="inline-empty"><strong>Stock looks healthy</strong><p>No configured low-stock thresholds are currently breached.</p></div>}</Card></div>
    <div className="dashboard-lower dashboard-lower-secondary"><Card className="activity-card"><div className="card-heading"><div><h2>Top selling items</h2><p>Revenue from posted sales</p></div></div>{sales.topItems.length === 0 ? <p className="finance-empty">No posted item sales found.</p> : <div className="compact-list">{sales.topItems.slice(0, 5).map((item) => <div className="compact-item" key={item.itemId}><div><strong>{item.itemName}</strong><small>{item.quantity} units</small></div><span>{money(item.revenue, data.currency)}</span></div>)}</div>}</Card><Card className="activity-card"><div className="card-heading"><div><h2>Cash position</h2><p>Accounting balances from posted journals</p></div></div><div className="compact-list"><div className="compact-item"><strong>Cash</strong><span>{money(finance.cash, data.currency)}</span></div><div className="compact-item"><strong>Bank</strong><span>{money(finance.bank, data.currency)}</span></div></div><p className="report-generated">Generated {new Date(data.generatedAt).toLocaleString()}</p></Card></div>
  </main>;
}

function Metric({ label, value, delta, icon: Icon, tone }: { label: string; value: string; delta: string; icon: typeof CircleDollarSign; tone: string }) { return <Card className="metric-card"><div className="metric-topline"><div className={`metric-icon metric-${tone}`}><Icon size={18} /></div><span className="metric-badge">Authoritative</span></div><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><span className="metric-change">{delta}</span></Card>; }
function TrendBars({ rows }: { rows: Dashboard["sales"]["trend"] }) { const maximum = Math.max(...rows.map((row) => Number(row.total)), 1); return <>{rows.map((row) => <div className="trend-bar-wrap" key={row.date}><span className="trend-bar" style={{ height: `${Math.max((Number(row.total) / maximum) * 100, 8)}%` }} title={`${row.date}: ${row.total}`} /><small>{row.date.slice(5)}</small></div>)}</>; }
