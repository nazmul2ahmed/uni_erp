import { relations } from "drizzle-orm";
import {
  customers,
  suppliers,
  items,
  taxProfiles,
} from "./core";
import {
  purchases,
  sales,
  receivables,
  payables,
} from "./commerce";

export const taxProfilesRelations = relations(taxProfiles, ({ many }) => ({
  items: many(items),
}));

export const itemsRelations = relations(items, ({ one }) => ({
  taxProfile: one(taxProfiles, {
    fields: [items.taxProfileId],
    references: [taxProfiles.id],
  }),
}));

export const customersRelations = relations(customers, ({ many }) => ({
  sales: many(sales),
  receivables: many(receivables),
}));

export const suppliersRelations = relations(suppliers, ({ many }) => ({
  purchases: many(purchases),
  payables: many(payables),
}));

export const salesRelations = relations(sales, ({ one, many }) => ({
  customer: one(customers, {
    fields: [sales.customerId],
    references: [customers.id],
  }),
  receivables: many(receivables),
}));

export const purchasesRelations = relations(purchases, ({ one, many }) => ({
  supplier: one(suppliers, {
    fields: [purchases.supplierId],
    references: [suppliers.id],
  }),
  payables: many(payables),
}));

export const receivablesRelations = relations(receivables, ({ one }) => ({
  customer: one(customers, {
    fields: [receivables.customerId],
    references: [customers.id],
  }),
  sale: one(sales, {
    fields: [receivables.saleId],
    references: [sales.id],
  }),
}));

export const payablesRelations = relations(payables, ({ one }) => ({
  supplier: one(suppliers, {
    fields: [payables.supplierId],
    references: [suppliers.id],
  }),
  purchase: one(purchases, {
    fields: [payables.purchaseId],
    references: [purchases.id],
  }),
}));
