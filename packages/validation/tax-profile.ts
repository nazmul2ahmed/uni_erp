import { z } from "zod";
import { shortTextSchema } from "./shared";

export const createTaxProfileSchema = z.object({
  name: shortTextSchema(100),
  rate: z
    .string()
    .trim()
    .regex(/^\d{1,5}(\.\d{1,4})?$/, "Rate must be a non-negative percentage with at most 4 decimal places"),
});
export type CreateTaxProfileInput = z.infer<typeof createTaxProfileSchema>;
