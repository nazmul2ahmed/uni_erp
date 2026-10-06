"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";

type MovementRow = {
  id: string;
  movementType: string;
  quantity: string | number;
  warehouseId: string;
  itemId: string;
};

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(body.error?.message || "Unable to load movements");
  }
  return body.data as T;
}

export default function InventoryMovementsPage() {
  const [rows, setRows] = useState<MovementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        setLoading(true);
        setError(null);
        const movements = await api<MovementRow[]>("/api/inventory/movements");
        const filtered = query
          ? movements.filter((row) =>
              [row.movementType, row.itemId, row.warehouseId].some((value) => value.toLowerCase().includes(query.toLowerCase())),
            )
          : movements;
        setRows(filtered);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load movements");
      } finally {
        setLoading(false);
      }
    })();
  }, [query]);

  return (
    <div className="page-content">
      <div className="business-header">
        <div>
          <p className="eyebrow">STOCK MOVEMENTS</p>
          <h1>Movements</h1>
          <p className="page-description">Ledger activity for inventory changes.</p>
        </div>
      </div>

      <section className="table-panel">
        <div className="table-toolbar">
          <label className="table-search">
            <Search size={17} />
            <input aria-label="Search movements" placeholder="Filter movements" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <span className="table-count">{rows.length} records</span>
        </div>

        {loading ? (
          <div className="table-loading">{[1, 2, 3, 4].map((item) => <div className="skeleton" key={item} />)}</div>
        ) : error ? (
          <div className="inline-error">
            <strong>Unable to load movements</strong>
            <p>{error}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="inline-empty">
            <strong>No movement history</strong>
            <p>Inventory ledger entries will appear here once stock changes are posted.</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Item</th>
                  <th>Warehouse</th>
                  <th>Quantity</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.movementType}</td>
                    <td>{row.itemId}</td>
                    <td>{row.warehouseId}</td>
                    <td>{String(row.quantity)}</td>
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
