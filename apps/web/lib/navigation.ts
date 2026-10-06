/**
 * Navigation + landing resolution -- 12_UX_SPECIFICATION.md s3.4, Decision NAV-001.
 *
 * s3.4: navigation is "a pure function of (enabledModules,
 * activeIndustryExtensions, actorPermissions)". Core has no module or
 * extension items yet, so today the only input is the actor's permissions;
 * module/extension items will be added to NAV_ITEMS by their own modules.
 *
 * SECURITY NOTE (13 s3.3 -- the client is never trusted): this only decides
 * what is DISPLAYED. Every API route still enforces its own permission on
 * the server. Unknown permissions (not loaded yet / no active tenant) fail
 * closed for display: nothing gated is shown.
 *
 * Each item's `requires` is the permission the page's primary API demands;
 * test/navigation.test.ts keeps the two from drifting apart.
 */

export type NavKey = "dashboard" | "sales" | "purchases" | "customers" | "suppliers" | "finance" | "expenses" | "reports" | "settings";

export interface NavItem {
  key: NavKey;
  label: string;
  href: string;
  /** Permission needed to show the item (and to use the page's primary API). */
  requires: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "dashboard", label: "Dashboard", href: "/dashboard", requires: "reports.view" },
  { key: "sales", label: "Sales", href: "/sales", requires: "sales.view" },
  { key: "purchases", label: "Purchases", href: "/purchases", requires: "purchase.view" },
  { key: "customers", label: "Customers", href: "/customers", requires: "customers.view" },
  { key: "suppliers", label: "Suppliers", href: "/suppliers", requires: "suppliers.view" },
  { key: "finance", label: "Finance", href: "/finance", requires: "accounting.view" },
  { key: "expenses", label: "Expenses", href: "/expenses", requires: "expenses.view" },
  { key: "reports", label: "Reports", href: "/reports", requires: "reports.view" },
  { key: "settings", label: "Settings", href: "/settings", requires: "settings.view" },
];

export function can(permissions: readonly string[] | null | undefined, permission: string): boolean {
  return Array.isArray(permissions) && permissions.includes(permission);
}

/** The nav items this actor may see, in declared order. null/undefined => none (fail closed). */
export function visibleNavigation(permissions: readonly string[] | null | undefined): NavItem[] {
  return NAV_ITEMS.filter((item) => can(permissions, item.requires));
}

/** Where a user should land after signing in / opening "/" (Decision NAV-001). */
export const FALLBACK_LANDING = "/dashboard";
export function landingPath(permissions: readonly string[] | null | undefined): string {
  if (can(permissions, "reports.view")) return "/dashboard";
  if (can(permissions, "sales.create")) return "/sales/new"; // POS: first Sales item in 12 s3.1
  return visibleNavigation(permissions)[0]?.href ?? FALLBACK_LANDING;
}
