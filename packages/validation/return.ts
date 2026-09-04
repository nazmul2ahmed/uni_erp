import { z } from "zod";

const quantity = z.string().regex(/^\d+(\.\d{1,4})?$/, "Quantity must be a non-negative decimal").refine((value) => Number(value) > 0, "Quantity must be greater than zero");

export const returnLineSchema = z.object({
  sourceLineId: z.string().uuid(),
  quantity,
});

export const customerReturnSchema = z.object({
  saleId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  lines: z.array(returnLineSchema).min(1),
  notes: z.string().max(500).optional(),
});

export const supplierReturnSchema = z.object({
  purchaseId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  lines: z.array(returnLineSchema).min(1),
  notes: z.string().max(500).optional(),
});

export const stockAdjustmentSchema = z.object({
  itemId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  batchId: z.string().uuid().nullable().optional(),
  quantityDelta: z.string().regex(/^-?\d+(\.\d{1,4})?$/).refine((value) => Number(value) !== 0, "Adjustment cannot be zero"),
  reason: z.string().trim().min(1).max(120),
  reference: z.string().trim().max(240).optional(),
});

export const returnListQuerySchema = z.object({
  type: z.enum(["CUSTOMER_RETURN", "SUPPLIER_RETURN"]).optional(),
  saleId: z.string().uuid().optional(),
  purchaseId: z.string().uuid().optional(),
});

export type CustomerReturnInput = z.infer<typeof customerReturnSchema>;
export type SupplierReturnInput = z.infer<typeof supplierReturnSchema>;
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;