/**
 * Platform Integration Contract v1 -- Plan/31_PLATFORM_INTEGRATION_CONTRACT.md,
 * Decision PLT-002. The app-agnostic seam between ANY managed application and a
 * platform console: the console talks only to this versioned HTTP contract and never
 * to an application's database. Today the in-app /platform UI is its first client;
 * a separate multi-app platform can become another client unchanged.
 */
export const PLATFORM_CONTRACT_VERSION = "platform.v1";

export const APP_IDENTITY = {
  id: "uni_erp",
  name: "Ledgerly ERP",
  version: process.env.APP_VERSION ?? "0.1.0",
} as const;

/** What this application can report. A console adapts to this list instead of assuming. */
export const PLATFORM_CAPABILITIES = ["tenants.summary", "features.adoption", "users.count"] as const;

export interface PlatformEnvelope<T> {
  contractVersion: typeof PLATFORM_CONTRACT_VERSION;
  app: typeof APP_IDENTITY;
  generatedAt: string;
  data: T;
}

export function platformEnvelope<T>(data: T): PlatformEnvelope<T> {
  return { contractVersion: PLATFORM_CONTRACT_VERSION, app: APP_IDENTITY, generatedAt: new Date().toISOString(), data };
}
