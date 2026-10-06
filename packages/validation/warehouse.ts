import { z } from "zod";
import { idSchema, shortTextSchema } from "./shared";

export const createWarehouseSchema = z.object({
  name: shortTextSchema(200),
  code: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Z0-9_-]+$/, "Warehouse code must be uppercase letters/digits/-/_"),
  branchId: idSchema,
  isActive: z.boolean().optional(),
});
export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;

export const updateWarehouseSchema = z
  .object({
    name: shortTextSchema(200).optional(),
    branchId: idSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.branchId !== undefined || v.isActive !== undefined, {
    message: "At least one field must be provided",
  });
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;
