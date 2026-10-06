import { z } from "zod";
import { shortTextSchema } from "./shared";

export const createBranchSchema = z.object({
  name: shortTextSchema(200),
  code: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Z0-9_-]+$/, "Branch code must be uppercase letters/digits/-/_"),
  address: shortTextSchema(500).optional(),
  phone: shortTextSchema(30).optional(),
  isActive: z.boolean().optional(),
});
export type CreateBranchInput = z.infer<typeof createBranchSchema>;
