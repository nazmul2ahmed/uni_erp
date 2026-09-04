"use client";

import { AlertCircle, ArrowDownLeft, ArrowUpRight, Banknote, BookOpen, CircleDollarSign, LoaderCircle, RefreshCw, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type Envelope<T> = { success: boolean; data?: T; error?: { message?: string } };
type Summary = { receivables: string; payables: string; cash: string; bank: string; paymentCount: number; journalCount: number };
type Receivable = { id: string; customerId: string; saleId: string; amount: string; paidAmount: string; balance: string; status: string; dueDate: string | null; customer?: { name: string } | null; sale?: { invoiceNumber: string } | null };
type Payable = { id: string; supplierId: string; purchaseId: string; amount: string; paidAmount: string; balance: string; status: string; dueDate: string | null; supplier?: { name: string } | null; purchase?: { purchaseNumber: string } | null };
type Payment = { id: string; partyType: string; partyId: string; direction: string; amount: string; method: string; referenceNo: string | null; paidAt: string };
type Account = { id: string; code: string; name: string; type: string; isSystemAccount: boolean };
type Party = { id: string; name: string };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json() as Envelope<T>;
  if (!response.ok || !body.success) throw new Error(body.error?.message || "Unable to load finance data");
  return body.data as T;
}

const money = (value: string) => `৳${Number(value).toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (value: string) => new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

export default function FinancePage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [receivables, setReceivables] = useState<Receivable[]>([]);
  const [payables, setPayables] = useState<Payable[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [customers, setCustomers] = useState<Party[]>([]);
  const [suppliers, setSuppliers] = useState<Party[]>([]);
  const [tab, setTab] = useState<"overview" | "receivables" | "payables" | "payments">("overview");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [nextSummary, nextReceivables, nextPayables, nextPayments, nextAccounts, nextCustomers, nextSuppliers] = await Promise.all([
        api<Summary>("/api/finance"), api<Receivable[]>("/api/receivables"), api<Payable[]>("/api/payables"), api<Payment[]>("/api/payments"), api<Account[]>("/api/accounting/chart-of-accounts"), api<Party[]>("/api/customers"), api<Party[]>("/api/suppliers"),
      ]);
      setSummary(nextSummary); setReceivables(nextReceivables); setPayables(nextPayables); setPayments(nextPayments); setAccounts(nextAccounts); setCustomers(nextCustomers); setSuppliers(nextSuppliers);
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to load finance data"); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (loading) return <main className="page-content finance-page"><div className="finance-loading"><LoaderCircle className="spin" size={22} />Loading finance workspace</div></main>;
  if (error) return <main className="page-content finance-page"><div className="inline-error" role="alert"><AlertCircle size={22} /><strong>Finance data is unavailable</strong><p>{error}</p><button className="button button-outline" onClick={() => void load()}><RefreshCw size={15} />Try again</button></div></main>;

  return <main className="page-content finance-page">
    <header className="finance-header"><div><p className="eyebrow">FINANCE</p><h1>Financial control room</h1><p className="page-description">Authoritative balances from receivables, payables, payments, and posted journals.</p></div><button className="button button-outline" onClick={() => void load()}><RefreshCw size={15} />Refresh</button></header>
    <nav className="finance-tabs" aria-label="Finance views">{([["overview", "Overview"], ["receivables", "Receivables"], ["payables", "Payables"], ["payments", "Payments"]] as const).map(([value, label]) => <button className={tab === value ? "finance-tab-active" : ""} key={value} onClick={() => setTab(value)}>{label}</button>)}</nav>
    {tab === "overview" && <><div className="finance-metrics"><Metric icon={<Wallet size={19} />} label="Cash" value={money(summary?.cash || "0")} tone="green" /><Metric icon={<Banknote size={19} />} label="Bank" value={money(summary?.bank || "0")} tone="blue" /><Metric icon={<ArrowDownLeft size={19} />} label="Receivables" value={money(summary?.receivables || "0")} tone="amber" /><Metric icon={<ArrowUpRight size={19} />} label="Payables" value={money(summary?.payables || "0")} tone="red" /></div><div className="finance-columns"><section className="card finance-panel"><div className="card-heading"><div><h2>Open receivables</h2><p>Customer balances from the receivables ledger.</p></div><button className="text-button" onClick={() => setTab("receivables")}>View all</button></div><LedgerPreview rows={receivables.slice(0, 5)} kind="receivable" /></section><section className="card finance-panel"><div className="card-heading"><div><h2>Open payables</h2><p>Supplier balances from the payables ledger.</p></div><button className="text-button" onClick={() => setTab("payables")}>View all</button></div><LedgerPreview rows={payables.slice(0, 5)} kind="payable" /></section></div><section className="card finance-panel"><div className="card-heading"><div><h2>Chart of accounts</h2><p>Tenant-scoped accounts seeded by the accounting model.</p></div><span className="table-count">{accounts.length} accounts</span></div><div className="account-list">{accounts.slice(0, 8).map((account) => <div className="account-row" key={account.id}><span><strong>{account.code}</strong> {account.name}</span><span className="status-pill status-active">{account.type}</span></div>)}</div></section></>}
    {tab === "receivables" && <LedgerTable rows={receivables} kind="receivable" />}
    {tab === "payables" && <LedgerTable rows={payables} kind="payable" />}
    {tab === "payments" && <><PaymentForm customers={customers} suppliers={suppliers} onComplete={load} /><PaymentTable rows={payments} /></>}
  </main>;
}

function Metric({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone: string }) { return <section className="card finance-metric"><span className={`finance-metric-icon metric-${tone}`}>{icon}</span><span className="metric-label">{label}</span><strong className="finance-metric-value">{value}</strong></section>; }
function LedgerPreview({ rows, kind }: { rows: Array<Receivable | Payable>; kind: "receivable" | "payable" }) { return <div className="finance-preview">{rows.length === 0 ? <p className="finance-empty">No open balances.</p> : rows.map((row) => <div className="finance-preview-row" key={row.id}><span><strong>{kind === "receivable" ? (row as Receivable).customer?.name || "Customer" : (row as Payable).supplier?.name || "Supplier"}</strong><small>{kind === "receivable" ? (row as Receivable).sale?.invoiceNumber : (row as Payable).purchase?.purchaseNumber}</small></span><strong>{money(row.balance)}</strong></div>)}</div>; }
function LedgerTable({ rows, kind }: { rows: Array<Receivable | Payable>; kind: "receivable" | "payable" }) { return <section className="card finance-panel"><div className="card-heading"><div><h2>{kind === "receivable" ? "Customer receivables" : "Supplier payables"}</h2><p>Balances are returned by the server-side ledger query.</p></div></div><div className="table-scroll"><table><thead><tr><th>Party</th><th>Source</th><th>Original</th><th>Paid</th><th>Outstanding</th><th>Status</th><th>Due date</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{kind === "receivable" ? (row as Receivable).customer?.name : (row as Payable).supplier?.name}</td><td>{kind === "receivable" ? (row as Receivable).sale?.invoiceNumber : (row as Payable).purchase?.purchaseNumber}</td><td className="numeric">{money(row.amount)}</td><td className="numeric">{money(row.paidAmount)}</td><td className="numeric due-value">{money(row.balance)}</td><td><span className="status-pill status-pending">{row.status}</span></td><td>{row.dueDate ? date(row.dueDate) : "-"}</td></tr>)}</tbody></table></div>{rows.length === 0 && <p className="finance-empty">No balances found.</p>}</section>; }
function PaymentTable({ rows }: { rows: Payment[] }) { return <section className="card finance-panel"><div className="card-heading"><div><h2>Payment history</h2><p>Idempotent customer and supplier payments.</p></div></div><div className="table-scroll"><table><thead><tr><th>Date</th><th>Party type</th><th>Direction</th><th>Method</th><th>Reference</th><th>Amount</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{date(row.paidAt)}</td><td>{row.partyType}</td><td>{row.direction === "IN" ? "Inflow" : "Outflow"}</td><td>{row.method}</td><td>{row.referenceNo || "-"}</td><td className="numeric">{money(row.amount)}</td></tr>)}</tbody></table></div>{rows.length === 0 && <p className="finance-empty">No payments recorded.</p>}</section>; }

function PaymentForm({ customers, suppliers, onComplete }: { customers: Party[]; suppliers: Party[]; onComplete: () => Promise<void> }) {
  const [type, setType] = useState<"customer" | "supplier">("customer"); const [partyId, setPartyId] = useState(""); const [amount, setAmount] = useState(""); const [method, setMethod] = useState("CASH"); const [referenceNo, setReferenceNo] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setBusy(true); setError(null); try { await api(`/api/payments/${type}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(type === "customer" ? { customerId: partyId, amount, method, referenceNo: referenceNo || undefined } : { supplierId: partyId, amount, method, referenceNo: referenceNo || undefined }) }); setAmount(""); setReferenceNo(""); await onComplete(); } catch (err) { setError(err instanceof Error ? err.message : "Unable to record payment"); } finally { setBusy(false); } };
  const parties = type === "customer" ? customers : suppliers;
  return <section className="card finance-panel payment-form"><div className="card-heading"><div><h2>Record payment</h2><p>Server validates party ownership, amount, allocation, and idempotency.</p></div></div><form onSubmit={submit} className="finance-form-grid"><label>Payment type<select value={type} onChange={(event) => { setType(event.target.value as "customer" | "supplier"); setPartyId(""); }}><option value="customer">Customer payment</option><option value="supplier">Supplier payment</option></select></label><label>{type === "customer" ? "Customer" : "Supplier"}<select required value={partyId} onChange={(event) => setPartyId(event.target.value)}><option value="">Select party</option>{parties.map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}</select></label><label>Amount<input required min="0.01" step="0.01" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /></label><label>Method<select value={method} onChange={(event) => setMethod(event.target.value)}>{["CASH", "BANK", "MFS", "CARD", "CHEQUE", "ONLINE", "OTHER"].map((value) => <option key={value}>{value}</option>)}</select></label><label>Reference<input value={referenceNo} onChange={(event) => setReferenceNo(event.target.value)} placeholder="Optional reference" /></label><div className="finance-form-action"><button className="button button-primary" disabled={busy || !partyId}>{busy && <LoaderCircle className="spin" size={15} />}Record payment</button></div></form>{error && <p className="form-error" role="alert"><AlertCircle size={16} />{error}</p>}</section>;
}