"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";

type StockRow = {
  itemId: string;
  warehouseId: string;
  batchId?: string | null;
  quantityOnHand: string | number;
  quantityReserved?: string | number;
  updatedAt?: string;
};

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(body.error?.message || "Unable to load stock balances");
  }
  return body.data as T;
}

export default function InventoryStockPage() {
  const [rows, setRows] = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        setLoading(true);
        setError(null);
        const balances = await api<StockRow[]>("/api/inventory/stock");
        const filtered = query
          ? balances.filter((row) =>
              [String(row.itemId), String(row.warehouseId), String(row.batchId || "")].some((value) =>
                value.toLowerCase().includes(query.toLowerCase()),
              ),
            )
          : balances;
        setRows(filtered);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load stock balances");
      } finally {
        setLoading(false);
      }
    })();
  }, [query]);

  return (
    <div className="page-content">
      <div className="business-header">
        <div>
          <p className="eyebrow">STOCK BALANCES</p>
          <h1>Stock</h1>
          <p className="page-description">Current inventory availability by item and warehouse.</p>
        </div>
      </div>

      <section className="table-panel">
        <div className="table-toolbar">
          <label className="table-search">
            <Search size={17} />
            <input aria-label="Search stock" placeholder="Filter stock" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <span className="table-count">{rows.length} balances</span>
        </div>

        {loading ? (
          <div className="table-loading">{[1, 2, 3, 4].map((item) => <div className="skeleton" key={item} />)}</div>
        ) : error ? (
          <div className="inline-error">
            <strong>Unable to load stock</strong>
            <p>{error}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="inline-empty">
            <strong>No stock balances</strong>
            <p>No quantity is available for the current tenant.</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Warehouse</th>
                  <th>Batch</th>
                  <th>On hand</th>
                  <th>Reserved</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.itemId}-${row.warehouseId}-${row.batchId || "unbatched"}-${index}`}>
                    <td>{row.itemId}</td>
                    <td>{row.warehouseId}</td>
                    <td>{row.batchId || "-"}</td>
                    <td>{String(row.quantityOnHand)}</td>
                    <td>{String(row.quantityReserved ?? "0")}</td>
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
