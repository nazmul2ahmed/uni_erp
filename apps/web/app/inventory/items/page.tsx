"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Plus } from "lucide-react";

type ItemRow = {
  id: string;
  sku: string | null;
  name: string;
  type: string;
  isActive: boolean;
};

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(body.error?.message || "Unable to load items");
  }
  return body.data as T;
}

export default function InventoryItemsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<ItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        setLoading(true);
        setError(null);
        const items = await api<ItemRow[]>(`/api/items?q=${encodeURIComponent(query)}`);
        setRows(items);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load items");
      } finally {
        setLoading(false);
      }
    })();
  }, [query]);

  return (
    <div className="page-content">
      <div className="business-header">
        <div>
          <p className="eyebrow">ITEM MASTER</p>
          <h1>Items</h1>
          <p className="page-description">Search and manage the tenant item catalogue.</p>
        </div>
        <button className="button button-primary" onClick={() => router.push("/inventory/items/new")}>
          <Plus size={16} />Add item
        </button>
      </div>

      <section className="table-panel">
        <div className="table-toolbar">
          <label className="table-search">
            <Search size={17} />
            <input
              aria-label="Search items"
              placeholder="Search items by name or SKU"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <span className="table-count">{rows.length} records</span>
        </div>

        {loading ? (
          <div className="table-loading">{[1, 2, 3, 4].map((item) => <div className="skeleton" key={item} />)}</div>
        ) : error ? (
          <div className="inline-error">
            <strong>Unable to load items</strong>
            <p>{error}</p>
            <button className="button button-outline" onClick={() => setQuery(query)}>Try again</button>
          </div>
        ) : rows.length === 0 ? (
          <div className="inline-empty">
            <strong>No items yet</strong>
            <p>Start by creating your first inventory item.</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>SKU</th>
                  <th>Type</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <button className="entity-name" onClick={() => router.push(`/inventory/items/${row.id}`)}>
                        {row.name}
                      </button>
                    </td>
                    <td>{row.sku || "-"}</td>
                    <td>{row.type}</td>
                    <td>
                      <span className={`status-pill ${row.isActive ? "status-active" : "status-archived"}`}>
                        {row.isActive ? "Active" : "Archived"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
