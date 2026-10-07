"use client";

import { AlertCircle, ArrowDownLeft, ArrowUpRight, Banknote, BookOpen, CircleDollarSign, LoaderCircle, RefreshCw, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type Envelope<T> = { success: boolean; data?: T; error?: { message?: string } };
type Summary = { receivables: string; payables: string; cash: string; bank: string; paymentCount: number; journalCount: number };
type Receivable = { id: string; customerId: string; saleId: string; amount: string; paidAmount: string; balance: string; status: string; dueDate: string | null; source?: string; customer?: { name: string } | null; sale?: { invoiceNumber: string } | null };
type Payable = { id: string; supplierId: string; purchaseId: string; amount: string; paidAmount: string; balance: string; status: string; dueDate: string | null; source?: string; supplier?: { name: string } | null; purchase?: { purchaseNumber: string } | null };
type Payment = { id: string; partyType: string; partyId: string; direction: string; amount: string; method: string; referenceNo: string | null; paidAt: string };
type Account = { id: string; code: string; name: string; type: string; isSystemAccount: boolean; isActive: boolean };
type Party = { id: string; name: string };
type TrialBalance = {
  period: { dateFrom: string | null; dateTo: string | null };
  lines: Array<{ code: string; name: string; type: string; debit: string; credit: string }>;
  totals: { debit: string; credit: string };
};
type Period = { id: string; periodStart: string; periodEnd: string; status: "OPEN" | "CLOSED"; closedAt: string | null; closingJournalId: string | null };
type OpeningEntry = { id: string; entryType: string; referenceId: string; customerId: string | null; supplierId: string | null; accountCode: string | null; amount: string; paidAmount: string; balance: string; status: string; createdAt: string };
type ReportKind = "profit-and-loss" | "balance-sheet" | "cash-flow" | "receivable-aging" | "payable-aging";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json() as Envelope<T>;
  if (!response.ok || !body.success) throw new Error(body.error?.message || "Unable to load finance data");
  return body.data as T;
}

const money = (value: string) => `৳${Number(value).toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const preciseMoney = (value: string) => {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const decimals = fraction.padEnd(2, "0");
  return `৳${negative ? "-" : ""}${BigInt(whole).toLocaleString("en-BD")}.${decimals}`;
};
const date = (value: string) => new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

export default function FinancePage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [receivables, setReceivables] = useState<Receivable[]>([]);
  const [payables, setPayables] = useState<Payable[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [customers, setCustomers] = useState<Party[]>([]);
  const [suppliers, setSuppliers] = useState<Party[]>([]);
  const [tab, setTab] = useState<"overview" | "receivables" | "payables" | "payments" | "trial-balance" | "profit-and-loss" | "balance-sheet" | "cash-flow" | "receivable-aging" | "payable-aging" | "openings" | "journals" | "periods">("overview");
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
    <nav className="finance-tabs" aria-label="Finance views">{([["overview", "Overview"], ["receivables", "Receivables"], ["payables", "Payables"], ["payments", "Payments"], ["trial-balance", "Trial balance"], ["profit-and-loss", "P&L"], ["balance-sheet", "Balance sheet"], ["cash-flow", "Cash flow"], ["receivable-aging", "Receivable aging"], ["payable-aging", "Payable aging"], ["openings", "Opening balances"], ["journals", "Manual journal"], ["periods", "Periods"]] as const).map(([value, label]) => <button className={tab === value ? "finance-tab-active" : ""} key={value} onClick={() => setTab(value)}>{label}</button>)}</nav>
    {tab === "overview" && <><div className="finance-metrics"><Metric icon={<Wallet size={19} />} label="Cash" value={money(summary?.cash || "0")} tone="green" /><Metric icon={<Banknote size={19} />} label="Bank" value={money(summary?.bank || "0")} tone="blue" /><Metric icon={<ArrowDownLeft size={19} />} label="Receivables" value={money(summary?.receivables || "0")} tone="amber" /><Metric icon={<ArrowUpRight size={19} />} label="Payables" value={money(summary?.payables || "0")} tone="red" /></div><div className="finance-columns"><section className="card finance-panel"><div className="card-heading"><div><h2>Open receivables</h2><p>Customer balances from the receivables ledger.</p></div><button className="text-button" onClick={() => setTab("receivables")}>View all</button></div><LedgerPreview rows={receivables.slice(0, 5)} kind="receivable" /></section><section className="card finance-panel"><div className="card-heading"><div><h2>Open payables</h2><p>Supplier balances from the payables ledger.</p></div><button className="text-button" onClick={() => setTab("payables")}>View all</button></div><LedgerPreview rows={payables.slice(0, 5)} kind="payable" /></section></div><section className="card finance-panel"><div className="card-heading"><div><h2>Chart of accounts</h2><p>Tenant-scoped accounts seeded by the accounting model.</p></div><span className="table-count">{accounts.length} accounts</span></div><div className="account-list">{accounts.slice(0, 8).map((account) => <div className="account-row" key={account.id}><span><strong>{account.code}</strong> {account.name}</span><span className="status-pill status-active">{account.type}</span></div>)}</div></section></>}
    {tab === "receivables" && <LedgerTable rows={receivables} kind="receivable" />}
    {tab === "payables" && <LedgerTable rows={payables} kind="payable" />}
    {tab === "payments" && <><PaymentForm customers={customers} suppliers={suppliers} onComplete={load} /><PaymentTable rows={payments} /></>}
    {tab === "trial-balance" && <TrialBalancePanel />}
    {(["profit-and-loss", "balance-sheet", "cash-flow", "receivable-aging", "payable-aging"] as const).includes(tab as ReportKind) && <AccountingReportPanel kind={tab as ReportKind} />}
    {tab === "openings" && <OpeningEntriesPanel customers={customers} suppliers={suppliers} accounts={accounts} />}
    {tab === "journals" && <ManualJournalPanel accounts={accounts} />}
    {tab === "periods" && <AccountingPeriodsPanel />}
  </main>;
}

function TrialBalancePanel() {
  const [report, setReport] = useState<TrialBalance | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    try {
      setReport(await api<TrialBalance>(`/api/accounting/trial-balance?${params}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load trial balance");
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo]);

  useEffect(() => { void load(); }, [load]);

  return <>
    <form className="report-filter-bar" onSubmit={(event) => { event.preventDefault(); void load(); }}>
      <label>From<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label>
      <label>To<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label>
      <button className="button" type="submit">Apply filters</button>
    </form>
    {loading ? <div className="finance-loading"><LoaderCircle className="spin" size={22} />Loading trial balance</div>
      : error ? <div className="inline-error" role="alert"><AlertCircle size={22} /><strong>Trial balance is unavailable</strong><p>{error}</p><button className="button button-outline" onClick={() => void load()}><RefreshCw size={15} />Try again</button></div>
        : report && <section className="card finance-panel">
          <div className="card-heading"><div><h2>Trial balance</h2><p>Posted journal entries{report.period.dateFrom || report.period.dateTo ? ` · ${report.period.dateFrom || "Any start"} to ${report.period.dateTo || "Any end"}` : " · All dates"}</p></div><span className="status-pill status-active">Balanced</span></div>
          {report.lines.length === 0 ? <p className="finance-empty">No posted journal entries in this period.</p> : <div className="table-scroll"><table><thead><tr><th>Account</th><th>Type</th><th className="numeric">Debit</th><th className="numeric">Credit</th></tr></thead><tbody>
            {report.lines.map((line) => <tr key={line.code}><td><strong>{line.code}</strong> {line.name}</td><td>{line.type}</td><td className="numeric">{preciseMoney(line.debit)}</td><td className="numeric">{preciseMoney(line.credit)}</td></tr>)}
            <tr><td colSpan={2}><strong>Totals</strong></td><td className="numeric"><strong>{preciseMoney(report.totals.debit)}</strong></td><td className="numeric"><strong>{preciseMoney(report.totals.credit)}</strong></td></tr>
          </tbody></table></div>}
        </section>}
  </>;
}

    function AccountingReportPanel({ kind }: { kind: ReportKind }) {
      const [data, setData] = useState<Record<string, unknown> | null>(null);
      const [dateFrom, setDateFrom] = useState("");
      const [dateTo, setDateTo] = useState("");
      const [asOfDate, setAsOfDate] = useState(new Date().toISOString().slice(0, 10));
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState<string | null>(null);
      const load = useCallback(async () => {
        setLoading(true); setError(null);
        const params = new URLSearchParams();
        if (kind === "balance-sheet" || kind.endsWith("-aging")) params.set("asOfDate", asOfDate);
        else {
          if (dateFrom) params.set("dateFrom", dateFrom);
          if (dateTo) params.set("dateTo", dateTo);
        }
        const endpoint = kind === "receivable-aging" ? "/api/receivables/aging"
          : kind === "payable-aging" ? "/api/payables/aging"
            : `/api/accounting/${kind}`;
        try { setData(await api<Record<string, unknown>>(`${endpoint}?${params}`)); }
        catch (err) { setError(err instanceof Error ? err.message : "Unable to load accounting report"); }
        finally { setLoading(false); }
      }, [asOfDate, dateFrom, dateTo, kind]);
      useEffect(() => { void load(); }, [load]);

      const title = kind === "profit-and-loss" ? "Profit & Loss"
        : kind === "balance-sheet" ? "Balance sheet"
          : kind === "cash-flow" ? "Cash flow"
            : kind === "receivable-aging" ? "Receivable aging" : "Payable aging";
      return <>
        <form className="report-filter-bar" onSubmit={(event) => { event.preventDefault(); void load(); }}>
          {kind === "balance-sheet" || kind.endsWith("-aging")
            ? <label>As of<input type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} /></label>
            : <div className="report-date-range"><label>From<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label>To<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label></div>}
          <button className="button" type="submit">Apply filters</button>
        </form>
        {loading
          ? <div className="finance-loading"><LoaderCircle className="spin" size={22} />Loading {title.toLowerCase()}</div>
          : error
            ? <div className="inline-error" role="alert"><AlertCircle size={22} /><strong>{title} is unavailable</strong><p>{error}</p><button className="button button-outline" onClick={() => void load()}><RefreshCw size={15} />Try again</button></div>
            : data ? <AccountingReportView kind={kind} data={data} /> : null}
      </>;
    }

    function AccountingReportView({ kind, data }: { kind: ReportKind; data: Record<string, unknown> }) {
      if (kind === "profit-and-loss") {
        const revenue = data.revenue as { lines: Array<{ code: string; name: string; amount: string }>; total: string };
        const opex = data.operatingExpenses as { lines: Array<{ code: string; name: string; amount: string }>; total: string };
        const cogs = data.cogs as { total: string };
        return <section className="card finance-panel"><div className="card-heading"><div><h2>Profit & Loss</h2><p>Derived from posted income and expense journals.</p></div></div>
          <ReportRows rows={[...revenue.lines.map((row) => [row.code, row.name, preciseMoney(row.amount)]), ["", "Total revenue", preciseMoney(revenue.total)], ["5000", "Cost of goods sold", preciseMoney(cogs.total)], ["", "Gross profit", preciseMoney(String(data.grossProfit))], ...opex.lines.map((row) => [row.code, row.name, preciseMoney(row.amount)]), ["", "Operating expenses", preciseMoney(opex.total)], ["", "Net profit", preciseMoney(String(data.netProfit))]]} headers={["Code", "Account", "Amount"]} />
        </section>;
      }
      if (kind === "balance-sheet") {
        const sectionRows = ["assets", "liabilities", "equity"].flatMap((key) => {
          const section = data[key] as { lines: Array<{ code: string; name: string; amount: string }>; total: string; currentEarnings?: string };
          return [["", key.toUpperCase(), ""], ...section.lines.map((row) => [row.code, row.name, preciseMoney(row.amount)]), ...(key === "equity" ? [["", "Current earnings", preciseMoney(section.currentEarnings ?? "0")]] : []), ["", `Total ${key}`, preciseMoney(section.total)]];
        });
        return <section className="card finance-panel"><div className="card-heading"><div><h2>Balance sheet</h2><p>As of {String(data.asOfDate)} · Assets must equal liabilities plus equity.</p></div><span className="status-pill status-active">Balanced</span></div><ReportRows rows={sectionRows} headers={["Code", "Account", "Amount"]} /></section>;
      }
      if (kind === "cash-flow") {
        return <section className="card finance-panel"><div className="card-heading"><div><h2>Cash flow</h2><p>Simplified direct method from Cash and Bank ledger movements.</p></div></div><ReportRows rows={[["", "Operating activities", preciseMoney(String(data.operatingActivities))], ["", "Investing activities", preciseMoney(String(data.investingActivities))], ["", "Financing activities", preciseMoney(String(data.financingActivities))], ["", "Net cash flow", preciseMoney(String(data.netCashFlow))]]} headers={["", "Activity", "Amount"]} /></section>;
      }
      const buckets = data.buckets as Record<string, string>;
      const rows = Object.entries(buckets).map(([key, value]) => ["", key.replaceAll("_", " "), preciseMoney(value)]);
      rows.push(["", "Total outstanding", preciseMoney(String(data.total))]);
      const agingRows = data.rows as Array<{ partyName: string; source: string; balance: string; dueDate: string | null; ageDays: number; bucket: string }>;
      return <><section className="card finance-panel"><div className="card-heading"><div><h2>{kind === "receivable-aging" ? "Receivable aging" : "Payable aging"}</h2><p>Outstanding balance buckets as of {String(data.asOfDate)}.</p></div></div><ReportRows rows={rows} headers={["", "Aging bucket", "Amount"]} /></section><ReportRowsCard title="Outstanding documents" rows={agingRows.map((row) => [row.partyName, row.source, row.dueDate ?? "-", `${row.ageDays} days`, row.bucket, preciseMoney(row.balance)])} headers={["Party", "Source", "Due date", "Age", "Bucket", "Balance"]} /></>;
    }

    function ReportRows({ rows, headers }: { rows: string[][]; headers: string[] }) {
      return <div className="table-scroll"><table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={`${index}-${row[1]}`}>{row.map((cell, column) => <td className={column === row.length - 1 ? "numeric" : undefined} key={`${column}-${cell}`}>{cell}</td>)}</tr>)}</tbody></table></div>;
    }
    function ReportRowsCard({ title, rows, headers }: { title: string; rows: string[][]; headers: string[] }) { return <section className="card finance-panel"><div className="card-heading"><h2>{title}</h2></div>{rows.length ? <ReportRows rows={rows} headers={headers} /> : <p className="finance-empty">No outstanding balances.</p>}</section>; }

    function OpeningEntriesPanel({ customers, suppliers, accounts }: { customers: Party[]; suppliers: Party[]; accounts: Account[] }) {
      const [rows, setRows] = useState<OpeningEntry[]>([]);
      const [entryType, setEntryType] = useState("CASH");
      const [amount, setAmount] = useState("");
      const [partyId, setPartyId] = useState("");
      const [accountCode, setAccountCode] = useState("");
      const [dueDate, setDueDate] = useState("");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState<string | null>(null);
      const load = useCallback(async () => setRows(await api<OpeningEntry[]>("/api/accounting/opening-entries")), []);
      useEffect(() => { void load().catch((err) => setError(err instanceof Error ? err.message : "Unable to load opening entries")); }, [load]);
      const submit = async (event: React.FormEvent) => {
        event.preventDefault(); setBusy(true); setError(null);
        const payload = { entryType, amount, ...(entryType === "CUSTOMER_RECEIVABLE" ? { customerId: partyId, dueDate: dueDate || undefined } : {}), ...(entryType === "SUPPLIER_PAYABLE" ? { supplierId: partyId, dueDate: dueDate || undefined } : {}), ...(entryType === "CAPITAL" ? { accountCode } : {}) };
        try {
          await api("/api/accounting/opening-entries", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(payload) });
          setAmount(""); setPartyId(""); setDueDate(""); await load();
        } catch (err) { setError(err instanceof Error ? err.message : "Unable to add opening balance"); }
        finally { setBusy(false); }
      };
      const parties = entryType === "CUSTOMER_RECEIVABLE" ? customers : suppliers;
      return <><section className="card finance-panel"><div className="card-heading"><div><h2>Record opening balance</h2><p>Each account or party can have one initial opening entry.</p></div></div>
        <form className="finance-form-grid" onSubmit={submit}><label>Entry type<select value={entryType} onChange={(event) => { setEntryType(event.target.value); setPartyId(""); }}><option value="CASH">Opening cash</option><option value="BANK">Opening bank</option><option value="STOCK">Opening stock</option><option value="CUSTOMER_RECEIVABLE">Customer receivable</option><option value="SUPPLIER_PAYABLE">Supplier payable</option><option value="CAPITAL">Opening capital</option></select></label>
          {(entryType === "CUSTOMER_RECEIVABLE" || entryType === "SUPPLIER_PAYABLE") && <label>{entryType === "CUSTOMER_RECEIVABLE" ? "Customer" : "Supplier"}<select required value={partyId} onChange={(event) => setPartyId(event.target.value)}><option value="">Select party</option>{parties.map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}</select></label>}
          {entryType === "CAPITAL" && <label>Balancing account<select required value={accountCode} onChange={(event) => setAccountCode(event.target.value)}><option value="">Select account</option>{accounts.filter((account) => account.isActive && account.type === "ASSET").map((account) => <option key={account.id} value={account.code}>{account.code} · {account.name}</option>)}</select></label>}
          <label>Amount<input required min="0.0001" step="0.0001" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
          {(entryType === "CUSTOMER_RECEIVABLE" || entryType === "SUPPLIER_PAYABLE") && <label>Due date<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>}
          <div className="finance-form-action"><button className="button" disabled={busy}>{busy && <LoaderCircle className="spin" size={15} />}Add opening balance</button></div>
        </form>{error && <p className="form-error" role="alert"><AlertCircle size={16} />{error}</p>}</section>
        <ReportRowsCard title="Opening entries" headers={["Type", "Reference", "Account", "Amount", "Paid", "Balance", "Status"]} rows={rows.map((row) => [row.entryType, row.customerId ? customers.find((party) => party.id === row.customerId)?.name ?? row.customerId : row.supplierId ? suppliers.find((party) => party.id === row.supplierId)?.name ?? row.supplierId : "Workspace", row.accountCode ?? "-", preciseMoney(row.amount), preciseMoney(row.paidAmount), preciseMoney(row.balance), row.status])} />
      </>;
    }

    function ManualJournalPanel({ accounts }: { accounts: Account[] }) {
      const [description, setDescription] = useState("");
      const [postedAt, setPostedAt] = useState(new Date().toISOString().slice(0, 10));
      const [lines, setLines] = useState([{ accountCode: "", debit: "", credit: "" }, { accountCode: "", debit: "", credit: "" }]);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState<string | null>(null);
      const submit = async (event: React.FormEvent) => {
        event.preventDefault(); setBusy(true); setError(null);
        try {
          await api("/api/accounting/journals", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ description: description || undefined, postedAt, entries: lines.map((line) => ({ accountCode: line.accountCode, ...(line.debit ? { debit: line.debit } : {}), ...(line.credit ? { credit: line.credit } : {}) })) }) });
          setDescription(""); setLines([{ accountCode: "", debit: "", credit: "" }, { accountCode: "", debit: "", credit: "" }]);
        } catch (err) { setError(err instanceof Error ? err.message : "Unable to post manual journal"); }
        finally { setBusy(false); }
      };
      return <section className="card finance-panel"><div className="card-heading"><div><h2>Manual journal adjustment</h2><p>Entries must balance; posting is permission-protected and audited.</p></div></div><form onSubmit={submit}><div className="finance-form-grid"><label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} /></label><label>Accounting date<input type="date" required value={postedAt} onChange={(event) => setPostedAt(event.target.value)} /></label></div>
        {lines.map((line, index) => <div className="finance-form-grid" key={index}><label>Account<select required value={line.accountCode} onChange={(event) => setLines((current) => current.map((entry, i) => i === index ? { ...entry, accountCode: event.target.value } : entry))}><option value="">Select account</option>{accounts.filter((account) => account.isActive).map((account) => <option value={account.code} key={account.id}>{account.code} · {account.name}</option>)}</select></label><label>Debit<input inputMode="decimal" value={line.debit} onChange={(event) => setLines((current) => current.map((entry, i) => i === index ? { ...entry, debit: event.target.value, credit: "" } : entry))} /></label><label>Credit<input inputMode="decimal" value={line.credit} onChange={(event) => setLines((current) => current.map((entry, i) => i === index ? { ...entry, credit: event.target.value, debit: "" } : entry))} /></label><button className="button button-outline" type="button" disabled={lines.length <= 2} onClick={() => setLines((current) => current.filter((_, i) => i !== index))}>Remove</button></div>)}
        <button className="button button-outline" type="button" onClick={() => setLines((current) => [...current, { accountCode: "", debit: "", credit: "" }])}>Add line</button> <button className="button" disabled={busy}>{busy && <LoaderCircle className="spin" size={15} />}Post journal</button>
      </form>{error && <p className="form-error" role="alert"><AlertCircle size={16} />{error}</p>}</section>;
    }

    function AccountingPeriodsPanel() {
      const [periods, setPeriods] = useState<Period[]>([]);
      const [periodEnd, setPeriodEnd] = useState(new Date().toISOString().slice(0, 10));
      const [draftCounts, setDraftCounts] = useState<{ sales: number; purchases: number } | null>(null);
      const [error, setError] = useState<string | null>(null);
      const [busy, setBusy] = useState(false);
      const load = useCallback(async () => setPeriods(await api<Period[]>("/api/accounting/periods")), []);
      useEffect(() => { void load().catch((err) => setError(err instanceof Error ? err.message : "Unable to load periods")); }, [load]);
      const close = async (confirmDrafts: boolean) => {
        setBusy(true); setError(null);
        try {
          const result = await api<{ closed: boolean; draftCounts: { sales: number; purchases: number } }>("/api/accounting/periods/close", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ periodEnd, confirmDrafts }) });
          setDraftCounts(result.closed ? null : result.draftCounts); await load();
        } catch (err) { setError(err instanceof Error ? err.message : "Unable to close period"); }
        finally { setBusy(false); }
      };
      const reopen = async (id: string) => {
        setBusy(true); setError(null);
        try { await api(`/api/accounting/periods/${id}/reopen`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } }); await load(); }
        catch (err) { setError(err instanceof Error ? err.message : "Unable to reopen period"); }
        finally { setBusy(false); }
      };
      return <><section className="card finance-panel"><div className="card-heading"><div><h2>Close accounting period</h2><p>The period begins after the previous close, or at the tenant&apos;s first journal date.</p></div></div><form className="finance-form-grid" onSubmit={(event) => { event.preventDefault(); void close(false); }}><label>Period end<input required type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} /></label><div className="finance-form-action"><button className="button" disabled={busy}>Close period</button></div></form>
        {draftCounts && <div className="form-error" role="alert"><p>{draftCounts.sales} draft sales and {draftCounts.purchases} draft purchases fall in this period. Confirm to continue.</p><button className="button" disabled={busy} onClick={() => void close(true)}>Close despite drafts</button></div>}
        {error && <p className="form-error" role="alert">{error}</p>}</section>
        <ReportRowsCard title="Accounting periods" headers={["Start", "End", "Status", "Closed at", "Action"]} rows={periods.map((period) => [period.periodStart, period.periodEnd, period.status, period.closedAt ? date(period.closedAt) : "-", period.status === "CLOSED" ? period.id : "OPEN"])} />
        {periods.filter((period) => period.status === "CLOSED").map((period) => <button className="button button-outline" key={period.id} disabled={busy} onClick={() => void reopen(period.id)}>Reopen {period.periodStart}–{period.periodEnd}</button>)}
      </>;
    }

function Metric({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone: string }) { return <section className="card finance-metric"><span className={`finance-metric-icon metric-${tone}`}>{icon}</span><span className="metric-label">{label}</span><strong className="finance-metric-value">{value}</strong></section>; }
function LedgerPreview({ rows, kind }: { rows: Array<Receivable | Payable>; kind: "receivable" | "payable" }) { return <div className="finance-preview">{rows.length === 0 ? <p className="finance-empty">No open balances.</p> : rows.map((row) => <div className="finance-preview-row" key={row.id}><span><strong>{kind === "receivable" ? (row as Receivable).customer?.name || "Customer" : (row as Payable).supplier?.name || "Supplier"}</strong><small>{kind === "receivable" ? (row as Receivable).sale?.invoiceNumber || ((row as Receivable).source === "OPENING_BALANCE" ? "Opening balance" : "") : (row as Payable).purchase?.purchaseNumber || ((row as Payable).source === "OPENING_BALANCE" ? "Opening balance" : "")}</small></span><strong>{money(row.balance)}</strong></div>)}</div>; }
function LedgerTable({ rows, kind }: { rows: Array<Receivable | Payable>; kind: "receivable" | "payable" }) { return <section className="card finance-panel"><div className="card-heading"><div><h2>{kind === "receivable" ? "Customer receivables" : "Supplier payables"}</h2><p>Balances are returned by the server-side ledger query.</p></div></div><div className="table-scroll"><table><thead><tr><th>Party</th><th>Source</th><th>Original</th><th>Paid</th><th>Outstanding</th><th>Status</th><th>Due date</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{kind === "receivable" ? (row as Receivable).customer?.name : (row as Payable).supplier?.name}</td><td>{kind === "receivable" ? (row as Receivable).sale?.invoiceNumber || ((row as Receivable).source === "OPENING_BALANCE" ? "Opening balance" : "-") : (row as Payable).purchase?.purchaseNumber || ((row as Payable).source === "OPENING_BALANCE" ? "Opening balance" : "-")}</td><td className="numeric">{money(row.amount)}</td><td className="numeric">{money(row.paidAmount)}</td><td className="numeric due-value">{money(row.balance)}</td><td><span className="status-pill status-pending">{row.status}</span></td><td>{row.dueDate ? date(row.dueDate) : "-"}</td></tr>)}</tbody></table></div>{rows.length === 0 && <p className="finance-empty">No balances found.</p>}</section>; }
function PaymentTable({ rows }: { rows: Payment[] }) { return <section className="card finance-panel"><div className="card-heading"><div><h2>Payment history</h2><p>Idempotent customer and supplier payments.</p></div></div><div className="table-scroll"><table><thead><tr><th>Date</th><th>Party type</th><th>Direction</th><th>Method</th><th>Reference</th><th>Amount</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{date(row.paidAt)}</td><td>{row.partyType}</td><td>{row.direction === "IN" ? "Inflow" : "Outflow"}</td><td>{row.method}</td><td>{row.referenceNo || "-"}</td><td className="numeric">{money(row.amount)}</td></tr>)}</tbody></table></div>{rows.length === 0 && <p className="finance-empty">No payments recorded.</p>}</section>; }

function PaymentForm({ customers, suppliers, onComplete }: { customers: Party[]; suppliers: Party[]; onComplete: () => Promise<void> }) {
  const [type, setType] = useState<"customer" | "supplier">("customer"); const [partyId, setPartyId] = useState(""); const [amount, setAmount] = useState(""); const [method, setMethod] = useState("CASH"); const [referenceNo, setReferenceNo] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setBusy(true); setError(null); try { await api(`/api/payments/${type}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(type === "customer" ? { customerId: partyId, amount, method, referenceNo: referenceNo || undefined } : { supplierId: partyId, amount, method, referenceNo: referenceNo || undefined }) }); setAmount(""); setReferenceNo(""); await onComplete(); } catch (err) { setError(err instanceof Error ? err.message : "Unable to record payment"); } finally { setBusy(false); } };
  const parties = type === "customer" ? customers : suppliers;
  return <section className="card finance-panel payment-form"><div className="card-heading"><div><h2>Record payment</h2><p>Server validates party ownership, amount, allocation, and idempotency.</p></div></div><form onSubmit={submit} className="finance-form-grid"><label>Payment type<select value={type} onChange={(event) => { setType(event.target.value as "customer" | "supplier"); setPartyId(""); }}><option value="customer">Customer payment</option><option value="supplier">Supplier payment</option></select></label><label>{type === "customer" ? "Customer" : "Supplier"}<select required value={partyId} onChange={(event) => setPartyId(event.target.value)}><option value="">Select party</option>{parties.map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}</select></label><label>Amount<input required min="0.01" step="0.01" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /></label><label>Method<select value={method} onChange={(event) => setMethod(event.target.value)}>{["CASH", "BANK", "MFS", "CARD", "CHEQUE", "ONLINE", "OTHER"].map((value) => <option key={value}>{value}</option>)}</select></label><label>Reference<input value={referenceNo} onChange={(event) => setReferenceNo(event.target.value)} placeholder="Optional reference" /></label><div className="finance-form-action"><button className="button button-primary" disabled={busy || !partyId}>{busy && <LoaderCircle className="spin" size={15} />}Record payment</button></div></form>{error && <p className="form-error" role="alert"><AlertCircle size={16} />{error}</p>}</section>;
}