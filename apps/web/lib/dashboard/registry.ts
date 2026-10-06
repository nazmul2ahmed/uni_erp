/**
 * Dashboard Widget Registry -- 12_UX_SPECIFICATION.md s8, Decision RPT-002.
 *
 * The Dashboard screen and API contain NO per-industry / per-module
 * branching: a widget declares itself (key, title, required permissions,
 * loader) and this engine decides, per request, which widgets the actor may
 * see. Industry/module widgets (Pharmacy expiry alerts, bookings, ...) add
 * themselves by calling `register` -- core code is never edited to add one.
 *
 * Security properties (fail closed, 05 s159 / 13 s3.3):
 *   - a widget MUST declare at least one required permission -- there is no
 *     "public" widget and no default-allow branch;
 *   - a widget is shown only if the actor holds ALL its required permissions;
 *   - a widget the actor may not see is OMITTED and its loader is NEVER run
 *     (no query executes on behalf of a forbidden widget);
 *   - missing/undefined `ctx.permissions` is treated as "no permissions".
 *
 * Tenant scoping stays in each loader (they receive the server-resolved
 * TenantContext and must use withTenantTransaction) -- the registry never
 * accepts a tenant id from the client.
 */
import type { TenantContext } from "../guard";

export type DashboardFilter = { dateFrom?: string; dateTo?: string };

export interface DashboardLoadContext {
  readonly ctx: TenantContext;
  readonly filter: DashboardFilter;
  /**
   * Per-request memo. Widgets that draw on the same expensive source (e.g.
   * the finance summary behind cash / receivables / payables) call
   * `once(sharedKey, loader)` so the source is queried a single time.
   */
  once<T>(key: string, load: () => Promise<T>): Promise<T>;
}

export interface DashboardWidget {
  readonly key: string;
  readonly title: string;
  /** ALL of these are required. Must be non-empty (fail closed). */
  readonly requiredPermissions: readonly string[];
  load(context: DashboardLoadContext): Promise<unknown>;
}

export interface DashboardWidgetResult {
  key: string;
  title: string;
  data: unknown;
}

export class DashboardRegistry {
  private readonly byKey = new Map<string, DashboardWidget>();

  register(widget: DashboardWidget): void {
    if (!widget.key) throw new Error("Dashboard widget must have a key");
    if (this.byKey.has(widget.key)) {
      throw new Error(`Dashboard widget already registered: ${widget.key}`);
    }
    if (widget.requiredPermissions.length === 0) {
      throw new Error(`Dashboard widget '${widget.key}' must declare at least one required permission`);
    }
    this.byKey.set(widget.key, widget);
  }

  list(): readonly DashboardWidget[] {
    return [...this.byKey.values()];
  }

  /** Widgets the actor may see, in registration order. */
  permitted(ctx: TenantContext): DashboardWidget[] {
    const granted = new Set(ctx.permissions ?? []);
    return this.list().filter((widget) => widget.requiredPermissions.every((p) => granted.has(p)));
  }

  async build(ctx: TenantContext, filter: DashboardFilter = {}): Promise<DashboardWidgetResult[]> {
    const cache = new Map<string, Promise<unknown>>();
    const loadContext: DashboardLoadContext = {
      ctx,
      filter,
      once<T>(key: string, load: () => Promise<T>): Promise<T> {
        let pending = cache.get(key);
        if (!pending) {
          pending = load();
          cache.set(key, pending);
        }
        return pending as Promise<T>;
      },
    };
    return Promise.all(
      this.permitted(ctx).map(async (widget) => ({
        key: widget.key,
        title: widget.title,
        data: await widget.load(loadContext),
      })),
    );
  }
}
