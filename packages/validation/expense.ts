import { z } from "zod";
import { idSchema, optionalShortTextSchema, positiveMoneyStringSchema } from "./shared";

/**
 * Expense domain schemas.
 * Per 07_CORE_DOMAIN_SPECIFICATION.md 14.1-14.2, 06 5.13,
 * 08_ACCOUNTING_ENGINE_SPECIFICATION.md 5.7 and 11_API_SPECIFICATION.md 13.
 * Decisions EXP-001 (category -> account), EXP-002 (CASH|BANK), EXP-003 (date).
 *
 * NOT included (never client-set): tenantId, createdBy, the journal/account
 * the expense posts to (derived server-side from the category), and
 * operationId (Idempotency-Key header, REQUIRED on POST /api/expenses).
 */

/** YYYY-MM-DD, and a real calendar date (rejects 2026-02-31). */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a date in YYYY-MM-DD format")
  .refine((value) => {
    const d = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }, "Must be a valid calendar date");

export const recordExpenseSchema = z.object({
  branchId: idSchema,
  categoryId: idSchema,
  amount: positiveMoneyStringSchema,
  paidVia: z.enum(["CASH", "BANK"]),
  expenseDate: isoDateSchema,
  description: optionalShortTextSchema(500),
});
export type RecordExpenseInput = z.infer<typeof recordExpenseSchema>;

export const createExpenseCategorySchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** Chart-of-accounts code of an EXPENSE account, e.g. "5200" Rent. 5000/5100 are refused server-side. */
  accountCode: z.string().trim().regex(/^\d{4,10}$/, "Must be a numeric account code"),
});
export type CreateExpenseCategoryInput = z.infer<typeof createExpenseCategorySchema>;

export const searchExpensesQuerySchema = z.object({
  categoryId: idSchema.optional(),
  branchId: idSchema.optional(),
  dateFrom: isoDateSchema.optional(),
  dateTo: isoDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type SearchExpensesQuery = z.infer<typeof searchExpensesQuerySchema>;

/**
 * Standard expense categories (Decision EXP-004): provisioned for every NEW
 * tenant at onboarding, and offered as a one-click "add standard categories"
 * action to existing tenants. Account codes are 08 3.5 (5200 Rent, 5300
 * Salary, 5400 Utility, 5900 Other -- `08`'s catch-all; inventory shrinkage
 * has its own account, 5500, Decision ACC-007). Tenant-editable afterwards: these are starting points, not rules.
 */
export const DEFAULT_EXPENSE_CATEGORIES: ReadonlyArray<{ name: string; accountCode: string }> = [
  { name: "Rent", accountCode: "5200" },
  { name: "Salaries", accountCode: "5300" },
  { name: "Utilities", accountCode: "5400" },
  { name: "Other expenses", accountCode: "5900" },
];

/** Reverse a posted expense (08 10.3, Decision EXP-005). A reason is mandatory: this is a financial correction. */
export const reverseExpenseSchema = z.object({
  reason: z.string().trim().min(3, "Give a reason of at least 3 characters").max(500),
});
export type ReverseExpenseInput = z.infer<typeof reverseExpenseSchema>;
