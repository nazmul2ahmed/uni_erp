import { z } from "zod";

/**
 * Optional Module / Industry Extension keys this Phase-1
 * implementation recognizes — per 02 §53's Core/Optional/Industry
 * classification. Core capabilities (sales, purchase, inventory,
 * accounting, customers, suppliers, catalog) are NEVER toggleable
 * here — they are not optional (03 §61's MVP boundary), so there is
 * no "sales" or "inventory" key in this list by design, not omission.
 *
 * NOTE (flagged, not silently assumed): `26 §3.3`'s `moduleEntitlements`
 * (a PLAN-level ceiling) is not wired to this table's runtime
 * resolution in this codebase yet — control.tenant_features here is
 * currently the ONLY enablement layer actually enforced, per
 * Decision BIL-007 (06 v2.0 §4.7) collapsing the "moduleState"
 * question. A tenant can toggle any key below regardless of their
 * (not-yet-implemented) plan entitlement. Full `resolveFeature()`
 * per 26 §6 is out of scope for this pass.
 *
 * `van_sales` added per `30_MODULE_VAN_SALES.md` §1/§9 ("enabled via
 * tenant_features.van_sales = true... extends the known-feature-key
 * list in packages/validation/tenant-features.ts"). This is wiring
 * for an already-ratified module classification, not a new decision —
 * no accompanying Plan/ or Amendment Ledger entry is required. The
 * module's own use cases (`IssueRepStockUseCase` etc., `30` §13 Phase 4)
 * do not exist yet in this codebase; this key merely makes the
 * feature-flag toggle reachable ahead of that work, per dependency-
 * ordered implementation (schema/config prerequisites before use cases).
 */
export const KNOWN_FEATURE_KEYS = ["quotation", "booking", "service", "rental", "project", "pharmacy", "electronics", "decorator", "van_sales"] as const;
export type KnownFeatureKey = (typeof KNOWN_FEATURE_KEYS)[number];

export const updateTenantFeaturesSchema = z.object({
  features: z
    .array(
      z.object({
        featureKey: z.enum(KNOWN_FEATURE_KEYS),
        enabled: z.boolean(),
      }),
    )
    .min(1, "At least one feature change is required"),
});
export type UpdateTenantFeaturesInput = z.infer<typeof updateTenantFeaturesSchema>;
