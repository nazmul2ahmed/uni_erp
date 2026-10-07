import { z } from "zod";
import { idSchema, optionalShortTextSchema, positiveMoneyStringSchema } from "./shared";

export const accountingDateFilterSchema = z.object({
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
}).refine((value) => !value.dateFrom || !value.dateTo || value.dateFrom <= value.dateTo, "dateFrom must be before dateTo");

export const balanceSheetFilterSchema = z.object({ asOfDate: z.string().date().optional() });

export const openingEntrySchema = z.discriminatedUnion("entryType", [
  z.object({ entryType: z.literal("CASH"), amount: positiveMoneyStringSchema }),
  z.object({ entryType: z.literal("BANK"), amount: positiveMoneyStringSchema }),
  z.object({ entryType: z.literal("STOCK"), amount: positiveMoneyStringSchema }),
  z.object({
    entryType: z.literal("CUSTOMER_RECEIVABLE"),
    amount: positiveMoneyStringSchema,
    customerId: idSchema,
    dueDate: z.string().date().optional(),
  }),
  z.object({
    entryType: z.literal("SUPPLIER_PAYABLE"),
    amount: positiveMoneyStringSchema,
    supplierId: idSchema,
    dueDate: z.string().date().optional(),
  }),
  z.object({ entryType: z.literal("CAPITAL"), amount: positiveMoneyStringSchema, accountCode: z.string().trim().min(1).max(32) }),
]);
export type OpeningEntryInput = z.infer<typeof openingEntrySchema>;

export const manualJournalLineSchema = z.object({
  accountCode: z.string().trim().min(1).max(32),
  debit: positiveMoneyStringSchema.optional(),
  credit: positiveMoneyStringSchema.optional(),
}).refine((line) => Boolean(line.debit) !== Boolean(line.credit), "Provide exactly one of debit or credit");

export const manualJournalSchema = z.object({
  description: optionalShortTextSchema(500),
  postedAt: z.string().date(),
  entries: z.array(manualJournalLineSchema).min(2).max(100),
});

export const closePeriodSchema = z.object({
  periodEnd: z.string().date(),
  confirmDrafts: z.boolean().optional(),
});

export const periodIdSchema = z.object({ id: idSchema });
