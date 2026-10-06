"use client";

import { AlertCircle, LoaderCircle, Plus, RefreshCw, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_EXPENSE_CATEGORIES } from "@erp/validation";
import { useAccess } from "@/components/access-context";
import { can } from "@/lib/navigation";
import { formatAmount, formatDateOnly, formatUnits, localToday, sumActiveAmounts, trimAmount, validateExpenseForm, validateReversalReason } from "@/lib/expense-ui";

type Envelope<T> = { success: boolean; data?: T; error?: { code?: string; message?: string } };
type Expense = {
  id: string; branchId: string; categoryId: string; categoryName: string; amount: string; description: string | null;
  paidVia: "CASH" | "BANK"; expenseDate: string; reversedAt: string | null; reversalReason: string | null;
};
type Category = { id: string; name: string; isActive: boolean; accountCode: string; accountName: string };
type Branch = { id: string; name: string };
type Account = { code: string; name: string; type: string };
type Prefill = { nonce: number; categoryId: string; amount: string; paidVia: "CASH" | "BANK"; expenseDate: string; description: string };

const LIST_LIMIT = 100;
// Starting points always offered when creating a category (system accounts are provisioned on first use).
const STANDARD_ACCOUNTS: Account[] = [
  { code: "5200", name: "Rent Expense", type: "EXPENSE" },
  { code: "5300", name: "Salary Expense", type: "EXPENSE" },
  { code: "5400", name: "Utility Expense", type: "EXPENSE" },
  { code: "5900", name: "Other Expense", type: "EXPENSE" },
];
// 5000 COGS / 5100 Discount Given / 5500 Inventory Shrinkage are system-posted -- the server refuses them, so never offer them.
const RESERVED_ACCOUNT_CODES = new Set(["5000", "5100", "5500"]);

class ApiError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null) as Envelope<T> | null;
  if (!response.ok || !body?.success) throw new ApiError(body?.error?.message || "Unable to complete the request", body?.error?.code);
  return body.data as T;
}

const jsonHeaders = { "Content-Type": "application/json" };

export default function ExpensesPage() {
  const access = useAccess();
  // Display hints from /api/auth/me (Decision NAV-001); the server enforces each action regardless.
  const canCreate = can(access.permissions, "expenses.create");
  const canManage = can(access.permissions, "expenses.manage");
  const canReverse = can(access.permissions, "expenses.reverse");

  const [tab, setTab] = useState<"expenses" | "categories">("expenses");
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [chartAccounts, setChartAccounts] = useState<Account[]>([]);
  const [filters, setFilters] = useState({ categoryId: "", dateFrom: "", dateTo: "" });
  const [reversing, setReversing] = useState<Expense | null>(null);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: String(LIST_LIMIT) });
      for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
      const [nextExpenses, nextCategories, nextBranches] = await Promise.all([
        api<Expense[]>(`/api/expenses?${query}`),
        api<Category[]>("/api/expense-categories"),
        // Listing branches needs catalog.view; a role without it can still read expenses, it just cannot record one.
        api<Branch[]>("/api/branches").catch(() => [] as Branch[]),
      ]);
      setExpenses(nextExpenses);
      setCategories(nextCategories);
      setBranches(nextBranches);
      // Best effort: custom EXPENSE accounts for the category form. Needs accounting.view; the standard list works without it.
      api<Account[]>("/api/accounting/chart-of-accounts").then(setChartAccounts).catch(() => setChartAccounts([]));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load expenses");
    } finally {
      setLoading(false);
    }
  }, [filters]);
  useEffect(() => { void load(); }, [load]);

  if (loading && expenses.length === 0 && categories.length === 0) return <main className="page-content finance-page"><div className="finance-loading"><LoaderCircle className="spin" size={22} />Loading expenses</div></main>;
  if (error) return <main className="page-content finance-page"><div className="inline-error" role="alert"><AlertCircle size={22} /><strong>Expenses are unavailable</strong><p>{error}</p><button className="button button-outline" onClick={() => void load()}><RefreshCw size={15} />Try again</button></div></main>;

  return <main className="page-content finance-page">
    <header className="finance-header">
      <div><p className="eyebrow">ACCOUNTING</p><h1>Expenses</h1><p className="page-description">Rent, salaries, utilities and other running costs. Each expense posts to the ledger and reduces net profit.</p></div>
      <button className="button button-outline" onClick={() => void load()}><RefreshCw size={15} />Refresh</button>
    </header>
    <nav className="finance-tabs" aria-label="Expense views">
      {([["expenses", "Expenses"], ["categories", "Categories"]] as const).map(([value, label]) => <button className={tab === value ? "finance-tab-active" : ""} key={value} onClick={() => setTab(value)}>{label}</button>)}
    </nav>
    {tab === "expenses" && <>
      {canCreate && <ExpenseForm branches={branches} categories={categories.filter((c) => c.isActive)} prefill={prefill} canManageCategories={canManage} onRecorded={load} onNeedCategories={() => setTab("categories")} />}
      {reversing && <ReversePanel expense={reversing} onCancel={() => setReversing(null)} onDone={async (reEnter) => {
        if (reEnter && canCreate) setPrefill({ nonce: Date.now(), categoryId: reversing.categoryId, amount: trimAmount(reversing.amount), paidVia: reversing.paidVia, expenseDate: reversing.expenseDate, description: reversing.description ?? "" });
        setReversing(null);
        await load();
      }} />}
      <ExpenseHistory rows={expenses} categories={categories} filters={filters} onFilters={setFilters} onReverse={canReverse ? setReversing : undefined} />
    </>}
    {tab === "categories" && <CategoriesPanel categories={categories} chartAccounts={chartAccounts} canManage={canManage} onChanged={load} />}
  </main>;
}

function ExpenseForm({ branches, categories, prefill, canManageCategories, onRecorded, onNeedCategories }: { branches: Branch[]; categories: Category[]; prefill: Prefill | null; canManageCategories: boolean; onRecorded: () => Promise<void>; onNeedCategories: () => void }) {
  const today = localToday();
  const [form, setForm] = useState({ branchId: "", categoryId: "", amount: "", paidVia: "CASH", expenseDate: today, description: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  // One idempotency key per entry: kept across failed/timed-out attempts so a retry can never post twice,
  // and rotated only after the server confirms the expense.
  const idempotencyKey = useRef<string>(crypto.randomUUID());
  const branchId = form.branchId || branches[0]?.id || "";
  const update = (field: keyof typeof form, value: string) => { setNotice(null); setForm((current) => ({ ...current, [field]: value })); };

  // "Reverse and re-enter": load the reversed expense's details back into the form as a NEW entry (new key).
  useEffect(() => {
    if (!prefill) return;
    setForm((current) => ({ ...current, categoryId: prefill.categoryId, amount: prefill.amount, paidVia: prefill.paidVia, expenseDate: prefill.expenseDate, description: prefill.description }));
    idempotencyKey.current = crypto.randomUUID();
    setError(null);
    setNotice("The expense was reversed. Correct the details below and record it again.");
    sectionRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [prefill?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const values = { ...form, branchId };
    const problem = validateExpenseForm(values, today);
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      await api("/api/expenses", {
        method: "POST",
        headers: { ...jsonHeaders, "Idempotency-Key": idempotencyKey.current },
        body: JSON.stringify({ branchId, categoryId: values.categoryId, amount: values.amount.trim(), paidVia: values.paidVia, expenseDate: values.expenseDate, description: values.description.trim() || undefined }),
      });
      idempotencyKey.current = crypto.randomUUID();
      setForm((current) => ({ ...current, amount: "", description: "" }));
      setNotice("Expense recorded and posted to the ledger.");
      await onRecorded();
    } catch (err) {
      if (err instanceof ApiError && err.code === "IDEMPOTENCY_KEY_REUSED") {
        idempotencyKey.current = crypto.randomUUID();
        setError("An earlier attempt with different details may already have been saved. Check the history below before submitting again.");
        await onRecorded();
      } else {
        setError(err instanceof Error ? err.message : "Unable to record the expense");
      }
    } finally {
      setBusy(false);
    }
  };

  if (branches.length === 0) return <section className="card finance-panel"><div className="card-heading"><div><h2>Record expense</h2><p>Recording an expense needs access to your branches (catalog access). Ask a workspace owner to update your role.</p></div></div></section>;
  if (categories.length === 0) return <section className="card finance-panel"><div className="card-heading"><div><h2>Record expense</h2><p>{canManageCategories ? "You need at least one expense category first." : "No expense categories exist yet. Ask a workspace owner to set them up."}</p></div></div>{canManageCategories && <button className="button button-primary" onClick={onNeedCategories}><Plus size={15} />Set up categories</button>}</section>;

  return <section ref={sectionRef} className="card finance-panel payment-form">
    <div className="card-heading"><div><h2>Record expense</h2><p>The server validates the category, branch, date and amount, and posts the journal in the same transaction.</p></div></div>
    <form onSubmit={submit} className="finance-form-grid">
      <label>Category<select required value={form.categoryId} onChange={(event) => update("categoryId", event.target.value)}><option value="">Select category</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>Amount<input required inputMode="decimal" value={form.amount} onChange={(event) => update("amount", event.target.value)} placeholder="0.00" aria-describedby="expense-amount-hint" /></label>
      <label>Paid via<select value={form.paidVia} onChange={(event) => update("paidVia", event.target.value)}><option value="CASH">Cash</option><option value="BANK">Bank</option></select></label>
      <label>Date<input required type="date" max={today} value={form.expenseDate} onChange={(event) => update("expenseDate", event.target.value)} /></label>
      {branches.length > 1 && <label>Branch<select required value={branchId} onChange={(event) => update("branchId", event.target.value)}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}
      <label>Note<input maxLength={500} value={form.description} onChange={(event) => update("description", event.target.value)} placeholder="Optional" /></label>
      <div className="finance-form-action"><button className="button button-primary" disabled={busy}>{busy && <LoaderCircle className="spin" size={15} />}Record expense</button></div>
    </form>
    <p id="expense-amount-hint" className="finance-empty">Posted expenses cannot be edited or deleted. To fix a mistake, reverse the expense and record it again.</p>
    {notice && <p role="status" className="finance-empty">{notice}</p>}
    {error && <p className="form-error" role="alert"><AlertCircle size={16} />{error}</p>}
  </section>;
}

function ReversePanel({ expense, onCancel, onDone }: { expense: Expense; onCancel: () => void; onDone: (reEnter: boolean) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [reEnter, setReEnter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per reversal attempt, kept across failures so a retry cannot reverse twice (the server also allows a single reversal).
  const idempotencyKey = useRef<string>(crypto.randomUUID());

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const problem = validateReversalReason(reason);
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null);
    try {
      await api(`/api/expenses/${expense.id}/reverse`, { method: "POST", headers: { ...jsonHeaders, "Idempotency-Key": idempotencyKey.current }, body: JSON.stringify({ reason: reason.trim() }) });
      await onDone(reEnter);
    } catch (err) {
      if (err instanceof ApiError && err.code === "ALREADY_REVERSED") { await onDone(false); return; } // someone else got there first -- just refresh
      setError(err instanceof Error ? err.message : "Unable to reverse the expense");
      setBusy(false);
    }
  };

  return <section className="card finance-panel payment-form" aria-labelledby="reverse-heading">
    <div className="card-heading"><div><h2 id="reverse-heading">Reverse expense</h2><p>{formatDateOnly(expense.expenseDate)} · {expense.categoryName} · {formatAmount(expense.amount)} · {expense.paidVia === "CASH" ? "Cash" : "Bank"}. The original stays in the history, marked as reversed, and the ledger is corrected with an exact opposite entry.</p></div></div>
    <form onSubmit={submit} className="finance-form-grid">
      <label>Reason (required)<input required autoFocus maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Wrong category" /></label>
      <label className="checkbox-row"><input type="checkbox" checked={reEnter} onChange={(event) => setReEnter(event.target.checked)} />Enter the corrected expense next</label>
      <div className="finance-form-action">
        <button className="button button-primary" disabled={busy}>{busy && <LoaderCircle className="spin" size={15} />}Reverse expense</button>
        <button type="button" className="button button-outline" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
    {error && <p className="form-error" role="alert"><AlertCircle size={16} />{error}</p>}
  </section>;
}

function ExpenseHistory({ rows, categories, filters, onFilters, onReverse }: { rows: Expense[]; categories: Category[]; filters: { categoryId: string; dateFrom: string; dateTo: string }; onFilters: (next: { categoryId: string; dateFrom: string; dateTo: string }) => void; onReverse?: (expense: Expense) => void }) {
  const total = useMemo(() => sumActiveAmounts(rows), [rows]);
  const reversedCount = rows.filter((r) => r.reversedAt).length;
  const set = (field: keyof typeof filters, value: string) => onFilters({ ...filters, [field]: value });
  return <section className="card finance-panel">
    <div className="card-heading"><div><h2>Expense history</h2><p>{rows.length} shown{rows.length >= LIST_LIMIT ? ` (most recent ${LIST_LIMIT} — narrow the date range to see others)` : ""} · Total {formatUnits(total)}{reversedCount > 0 ? ` (excluding ${reversedCount} reversed)` : ""}</p></div></div>
    <div className="finance-form-grid" style={{ marginBottom: 15 }}>
      <label>Category<select value={filters.categoryId} onChange={(event) => set("categoryId", event.target.value)}><option value="">All categories</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>From<input type="date" value={filters.dateFrom} max={filters.dateTo || undefined} onChange={(event) => set("dateFrom", event.target.value)} /></label>
      <label>To<input type="date" value={filters.dateTo} min={filters.dateFrom || undefined} onChange={(event) => set("dateTo", event.target.value)} /></label>
    </div>
    <div className="table-scroll"><table>
      <thead><tr><th>Date</th><th>Category</th><th>Note</th><th>Paid via</th><th>Amount</th><th>Status</th>{onReverse && <th><span className="sr-only">Actions</span></th>}</tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id}>
        <td>{formatDateOnly(row.expenseDate)}</td><td>{row.categoryName}</td><td>{row.description || "-"}</td><td>{row.paidVia === "CASH" ? "Cash" : "Bank"}</td>
        <td className="numeric" style={row.reversedAt ? { textDecoration: "line-through" } : undefined}>{formatAmount(row.amount)}</td>
        <td>{row.reversedAt ? <span className="status-pill status-archived" title={row.reversalReason ?? undefined}>Reversed</span> : <span className="status-pill status-active">Posted</span>}{row.reversedAt && row.reversalReason && <small> {row.reversalReason}</small>}</td>
        {onReverse && <td>{!row.reversedAt && <button className="button button-outline" onClick={() => onReverse(row)} aria-label={`Reverse expense of ${formatAmount(row.amount)} on ${formatDateOnly(row.expenseDate)}`}><Undo2 size={14} />Reverse</button>}</td>}
      </tr>)}</tbody>
    </table></div>
    {rows.length === 0 && <p className="finance-empty">No expenses recorded for this selection.</p>}
  </section>;
}

function CategoriesPanel({ categories, chartAccounts, canManage, onChanged }: { categories: Category[]; chartAccounts: Account[]; canManage: boolean; onChanged: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [accountCode, setAccountCode] = useState(STANDARD_ACCOUNTS[0]!.code);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const accountOptions = useMemo(() => {
    const byCode = new Map<string, Account>();
    for (const a of STANDARD_ACCOUNTS) byCode.set(a.code, a);
    for (const a of chartAccounts) if (a.type === "EXPENSE" && !RESERVED_ACCOUNT_CODES.has(a.code)) byCode.set(a.code, a);
    return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [chartAccounts]);

  const missingDefaults = DEFAULT_EXPENSE_CATEGORIES.filter((d) => !categories.some((c) => c.name.toLowerCase() === d.name.toLowerCase()));

  const create = async (input: { name: string; accountCode: string }) =>
    api("/api/expense-categories", { method: "POST", headers: jsonHeaders, body: JSON.stringify(input) });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) { setError("Enter a category name"); return; }
    setBusy(true); setError(null); setNotice(null);
    try { await create({ name: name.trim(), accountCode }); setName(""); setNotice("Category added."); await onChanged(); }
    catch (err) { setError(err instanceof Error ? err.message : "Unable to add the category"); }
    finally { setBusy(false); }
  };

  // Uses the existing endpoint once per missing category; a name that already exists is skipped, so it is safe to repeat.
  const addStandard = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      for (const def of missingDefaults) {
        try { await create(def); } catch (err) { if (!(err instanceof ApiError && err.code === "DUPLICATE_RESOURCE")) throw err; }
      }
      setNotice("Standard categories added.");
      await onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to add the standard categories"); await onChanged(); }
    finally { setBusy(false); }
  };

  return <>
    {canManage && missingDefaults.length > 0 && <section className="card finance-panel">
      <div className="card-heading"><div><h2>Standard categories</h2><p>Add {missingDefaults.map((d) => d.name).join(", ")} in one step. You can add your own afterwards.</p></div></div>
      <button className="button button-primary" disabled={busy} onClick={() => void addStandard()}>{busy && <LoaderCircle className="spin" size={15} />}Add standard categories</button>
    </section>}
    {canManage && <section className="card finance-panel payment-form">
      <div className="card-heading"><div><h2>Add category</h2><p>Each category posts to one expense account in your chart of accounts.</p></div></div>
      <form onSubmit={submit} className="finance-form-grid">
        <label>Name<input required maxLength={100} value={name} onChange={(event) => { setNotice(null); setName(event.target.value); }} placeholder="e.g. Internet" /></label>
        <label>Ledger account<select value={accountCode} onChange={(event) => setAccountCode(event.target.value)}>{accountOptions.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}</select></label>
        <div className="finance-form-action"><button className="button button-primary" disabled={busy}>{busy && <LoaderCircle className="spin" size={15} />}Add category</button></div>
      </form>
      {notice && <p role="status" className="finance-empty">{notice}</p>}
      {error && <p className="form-error" role="alert"><AlertCircle size={16} />{error}</p>}
    </section>}
    <section className="card finance-panel">
      <div className="card-heading"><div><h2>Categories</h2><p>{categories.length} configured</p></div></div>
      <div className="table-scroll"><table>
        <thead><tr><th>Name</th><th>Ledger account</th><th>Status</th></tr></thead>
        <tbody>{categories.map((c) => <tr key={c.id}><td>{c.name}</td><td>{c.accountCode} · {c.accountName}</td><td><span className={`status-pill ${c.isActive ? "status-active" : "status-archived"}`}>{c.isActive ? "Active" : "Inactive"}</span></td></tr>)}</tbody>
      </table></div>
      {categories.length === 0 && <p className="finance-empty">No categories yet.</p>}
    </section>
  </>;
}
