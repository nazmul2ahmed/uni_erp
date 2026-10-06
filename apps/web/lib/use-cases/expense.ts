/**
 * Expense domain -- RecordExpenseUseCase (07 14.2), categories (11 13).
 * Spec: 06 5.13, 07 14, 08 5.7 / 10.3, 11 13.
 * Decisions: EXP-001 category -> expense account, EXP-002 paid_via CASH|BANK,
 * EXP-003 expense_date is the accounting effective date.
 *
 * RecordExpense runs in ONE tenant transaction (07 13.4): idempotency check ->
 * tenant-ownership checks -> persist expense -> post journal -> audit. A
 * posted expense is never edited or deleted (RLS is append-only for it);
 * corrections are reversal (reverseExpense) + a new record (08 10.3, Decision EXP-005).
 */
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { branches, expenseCategories, expenseReversals, expenses, accounts, journals, tenants, withTenantTransaction } from "@erp/db";
import { AppError } from "@erp/shared";
import { DEFAULT_EXPENSE_CATEGORIES } from "@erp/validation";
import type { Database } from "@erp/db";
import type { CreateExpenseCategoryInput, RecordExpenseInput, ReverseExpenseInput, SearchExpensesQuery } from "@erp/validation";
import type { TenantContext } from "../guard";
import { deterministicSubOperationId, postExpenseJournal, postReversalJournal, resolveExpenseCategoryAccount } from "../accounting";
import { recordAudit } from "../audit";
import { todayInTimezone } from "../tenant-date";

const DEFAULT_LIST_LIMIT = 50;
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

/** Exact decimal compare of two numeric strings (scale 4) without floats. */
function sameAmount(a: string, b: string): boolean {
  const units = (v: string) => {
    const [whole = "0", fraction = ""] = v.split(".");
    return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, "0").slice(0, 4));
  };
  return units(a) === units(b);
}

export async function recordExpense(ctx: TenantContext, input: RecordExpenseInput, operationId: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    // 1. Idempotency. Same key + same payload = replay; same key + different payload = misuse.
    const existing = await tx.query.expenses.findFirst({ where: and(eq(expenses.tenantId, ctx.tenantId), eq(expenses.operationId, operationId)) });
    if (existing) {
      const identical =
        existing.branchId === input.branchId &&
        existing.categoryId === input.categoryId &&
        existing.paidVia === input.paidVia &&
        existing.expenseDate === input.expenseDate &&
        sameAmount(existing.amount, input.amount) &&
        (existing.description ?? null) === (input.description?.trim() || null);
      if (!identical) throw new AppError("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different expense");
      return existing;
    }

    // 2. Tenant-ownership of every referenced row (05 81 cross-tenant FK guard) + no future dates (tenant tz).
    const [branch, category, tenant] = await Promise.all([
      tx.query.branches.findFirst({ where: and(eq(branches.id, input.branchId), eq(branches.tenantId, ctx.tenantId)) }),
      tx.query.expenseCategories.findFirst({ where: and(eq(expenseCategories.id, input.categoryId), eq(expenseCategories.tenantId, ctx.tenantId)) }),
      tx.query.tenants.findFirst({ where: eq(tenants.id, ctx.tenantId) }),
    ]);
    if (!branch) throw new AppError("RESOURCE_NOT_FOUND", "Branch not found");
    if (!category) throw new AppError("RESOURCE_NOT_FOUND", "Expense category not found");
    if (!category.isActive) throw new AppError("VALIDATION_FAILED", "Expense category is inactive", { field: "categoryId" });
    if (input.expenseDate > todayInTimezone(tenant?.timezone ?? "Asia/Dhaka")) {
      throw new AppError("VALIDATION_FAILED", "expenseDate cannot be in the future", { field: "expenseDate" });
    }
    const categoryAccount = await tx.query.accounts.findFirst({ where: and(eq(accounts.id, category.accountId), eq(accounts.tenantId, ctx.tenantId)) });
    if (!categoryAccount || categoryAccount.type !== "EXPENSE" || !categoryAccount.isActive) {
      throw new AppError("VALIDATION_FAILED", "Expense category is mapped to an unusable account", { field: "categoryId" });
    }

    // 3. Persist (a concurrent duplicate hits UNIQUE(tenant_id, operation_id) -> replay the winner).
    let expense: typeof expenses.$inferSelect | undefined;
    try {
      [expense] = await tx
        .insert(expenses)
        .values({
          tenantId: ctx.tenantId,
          branchId: input.branchId,
          categoryId: input.categoryId,
          amount: input.amount,
          description: input.description?.trim() || null,
          paidVia: input.paidVia,
          expenseDate: input.expenseDate,
          operationId,
          createdBy: ctx.userId,
        })
        .returning();
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key is already being processed");
      throw e;
    }
    if (!expense) throw new AppError("INTERNAL_ERROR", "Unable to record expense");

    // 4. Journal in the SAME transaction (Dr category account / Cr cash|bank), effective on expenseDate.
    await postExpenseJournal(tx, ctx, {
      expenseId: expense.id,
      operationId,
      amount: input.amount,
      categoryAccountCode: categoryAccount.code,
      paidVia: input.paidVia,
      postedAt: new Date(`${input.expenseDate}T12:00:00.000Z`),
      description: `Expense: ${category.name}`,
    });

    // 5. Audit (07 15.1) as the final step, inside the transaction.
    await recordAudit(tx, ctx, {
      action: "expense.record",
      entityType: "EXPENSE",
      entityId: expense.id,
      after: { amount: expense.amount, categoryId: expense.categoryId, branchId: expense.branchId, paidVia: expense.paidVia, expenseDate: expense.expenseDate },
    });

    return expense;
  });
}

export async function listExpenses(ctx: TenantContext, filters: SearchExpensesQuery = {}) {
  return withTenantTransaction(ctx.tenantId, async (tx) =>
    tx
      .select({
        id: expenses.id,
        branchId: expenses.branchId,
        categoryId: expenses.categoryId,
        categoryName: expenseCategories.name,
        amount: expenses.amount,
        description: expenses.description,
        paidVia: expenses.paidVia,
        expenseDate: expenses.expenseDate,
        createdAt: expenses.createdAt,
        // Decision EXP-005: reversed expenses stay in the history, flagged -- never hidden.
        reversedAt: expenseReversals.createdAt,
        reversalReason: expenseReversals.reason,
      })
      .from(expenses)
      .innerJoin(expenseCategories, and(eq(expenseCategories.id, expenses.categoryId), eq(expenseCategories.tenantId, ctx.tenantId)))
      .leftJoin(expenseReversals, and(eq(expenseReversals.expenseId, expenses.id), eq(expenseReversals.tenantId, ctx.tenantId)))
      .where(
        and(
          eq(expenses.tenantId, ctx.tenantId),
          filters.categoryId ? eq(expenses.categoryId, filters.categoryId) : undefined,
          filters.branchId ? eq(expenses.branchId, filters.branchId) : undefined,
          filters.dateFrom ? gte(expenses.expenseDate, filters.dateFrom) : undefined,
          filters.dateTo ? lte(expenses.expenseDate, filters.dateTo) : undefined,
        ),
      )
      .orderBy(desc(expenses.expenseDate), desc(expenses.createdAt))
      .limit(filters.limit ?? DEFAULT_LIST_LIMIT)
      .offset(filters.offset ?? 0),
  );
}

export async function createExpenseCategory(ctx: TenantContext, input: CreateExpenseCategoryInput) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const account = await resolveExpenseCategoryAccount(tx, ctx.tenantId, input.accountCode);
    let category: typeof expenseCategories.$inferSelect | undefined;
    try {
      [category] = await tx.insert(expenseCategories).values({ tenantId: ctx.tenantId, name: input.name, accountId: account.id }).returning();
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError("DUPLICATE_RESOURCE", "An expense category with this name already exists", { field: "name" });
      throw e;
    }
    if (!category) throw new AppError("INTERNAL_ERROR", "Unable to create expense category");
    await recordAudit(tx, ctx, {
      action: "expense_category.create",
      entityType: "EXPENSE_CATEGORY",
      entityId: category.id,
      after: { name: category.name, accountCode: account.code },
    });
    return { ...category, accountCode: account.code, accountName: account.name };
  });
}

export async function listExpenseCategories(ctx: TenantContext) {
  return withTenantTransaction(ctx.tenantId, async (tx) =>
    tx
      .select({
        id: expenseCategories.id,
        name: expenseCategories.name,
        isActive: expenseCategories.isActive,
        accountCode: accounts.code,
        accountName: accounts.name,
      })
      .from(expenseCategories)
      .innerJoin(accounts, and(eq(accounts.id, expenseCategories.accountId), eq(accounts.tenantId, ctx.tenantId)))
      .where(eq(expenseCategories.tenantId, ctx.tenantId))
      .orderBy(expenseCategories.name),
  );
}

/**
 * Provision the standard categories (Decision EXP-004) for a tenant. Idempotent:
 * a category whose name already exists (case-insensitive) is left alone, so it is
 * safe at onboarding and safe to re-run. System provisioning, not a user action,
 * hence no audit entry (same as the chart-of-accounts seeding it sits beside).
 * Caller must already be inside a tenant-scoped transaction (app.tenant_id set).
 */
export async function ensureDefaultExpenseCategories(tx: Database, tenantId: string): Promise<void> {
  const existing = await tx.query.expenseCategories.findMany({ where: eq(expenseCategories.tenantId, tenantId) });
  const taken = new Set(existing.map((c) => c.name.toLowerCase()));
  for (const def of DEFAULT_EXPENSE_CATEGORIES) {
    if (taken.has(def.name.toLowerCase())) continue;
    const account = await resolveExpenseCategoryAccount(tx, tenantId, def.accountCode);
    await tx.insert(expenseCategories).values({ tenantId, name: def.name, accountId: account.id }).onConflictDoNothing();
  }
}

/**
 * ReverseExpenseUseCase -- 08 10.3, Decision EXP-005.
 * One tenant transaction: idempotency -> locate expense + its journal ->
 * postReversalJournal (exact mirror, 08 5.9) -> record the reversal -> audit.
 * An expense can be reversed ONCE (UNIQUE (tenant_id, expense_id) and the
 * one-reversal-per-journal index back up the check). To correct a mistake,
 * the caller then records a NEW expense with the right details.
 */
export async function reverseExpense(ctx: TenantContext, expenseId: string, input: ReverseExpenseInput, operationId: string) {
  const reason = input.reason.trim();
  if (reason.length < 3) throw new AppError("VALIDATION_FAILED", "A reason of at least 3 characters is required", { field: "reason" });

  return withTenantTransaction(ctx.tenantId, async (tx) => {
    // 1. Idempotency: same key + same request = replay; same key + anything else = misuse.
    const replay = await tx.query.expenseReversals.findFirst({ where: and(eq(expenseReversals.tenantId, ctx.tenantId), eq(expenseReversals.operationId, operationId)) });
    if (replay) {
      if (replay.expenseId !== expenseId || replay.reason !== reason) throw new AppError("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different reversal");
      return replay;
    }

    // 2. The expense must belong to THIS tenant (RLS + explicit filter) and not be reversed yet.
    const expense = await tx.query.expenses.findFirst({ where: and(eq(expenses.id, expenseId), eq(expenses.tenantId, ctx.tenantId)) });
    if (!expense) throw new AppError("RESOURCE_NOT_FOUND", "Expense not found");
    const already = await tx.query.expenseReversals.findFirst({ where: and(eq(expenseReversals.tenantId, ctx.tenantId), eq(expenseReversals.expenseId, expense.id)) });
    if (already) throw new AppError("ALREADY_REVERSED", "This expense has already been reversed");

    const original = await tx.query.journals.findFirst({ where: and(eq(journals.tenantId, ctx.tenantId), eq(journals.referenceType, "EXPENSE"), eq(journals.referenceId, expense.id)) });
    if (!original) throw new AppError("INTERNAL_ERROR", "Expense has no journal to reverse");

    // 3. Mechanical mirror. The journal's operation id is DERIVED so a client that reuses the
    //    expense's own Idempotency-Key cannot make the reversal collapse onto the original journal.
    let reversal: typeof expenseReversals.$inferSelect | undefined;
    try {
      const journal = await postReversalJournal(tx, ctx, {
        originalJournalId: original.id,
        operationId: deterministicSubOperationId(operationId, "reversal"),
        reason,
      });
      [reversal] = await tx
        .insert(expenseReversals)
        .values({ tenantId: ctx.tenantId, expenseId: expense.id, reversalJournalId: journal.id, reason, operationId, createdBy: ctx.userId })
        .returning();
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError("ALREADY_REVERSED", "This expense has already been reversed");
      throw e;
    }
    if (!reversal) throw new AppError("INTERNAL_ERROR", "Unable to record expense reversal");

    // 4. Audit (07 15.1) with the reason.
    await recordAudit(tx, ctx, {
      action: "expense.reverse",
      entityType: "EXPENSE",
      entityId: expense.id,
      reason,
      before: { amount: expense.amount, categoryId: expense.categoryId, expenseDate: expense.expenseDate },
      after: { reversalJournalId: reversal.reversalJournalId },
    });
    return reversal;
  });
}
