"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Plus } from "lucide-react";

type WarehouseRow = {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
};

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(body.error?.message || "Unable to load warehouses");
  }
  return body.data as T;
}

export default function InventoryWarehousesPage() {
  const router = useRouter();
  const [rows, setRows] = useState<WarehouseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        setLoading(true);
        setError(null);
        const warehouses = await api<WarehouseRow[]>("/api/warehouses");
        const filtered = query
          ? warehouses.filter((row) => [row.name, row.code].some((value) => value.toLowerCase().includes(query.toLowerCase())))
          : warehouses;
        setRows(filtered);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load warehouses");
      } finally {
        setLoading(false);
      }
    })();
  }, [query]);

  return (
    <div className="page-content">
      <div className="business-header">
        <div>
          <p className="eyebrow">WAREHOUSES</p>
          <h1>Warehouses</h1>
          <p className="page-description">Inventory storage points in the active tenant.</p>
        </div>
        <button className="button button-primary" onClick={() => router.push("/inventory/warehouses/new")}>
          <Plus size={16} />Add warehouse
        </button>
      </div>

      <section className="table-panel">
        <div className="table-toolbar">
          <label className="table-search">
            <Search size={17} />
            <input
              aria-label="Search warehouses"
              placeholder="Search warehouses"
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
            <strong>Unable to load warehouses</strong>
            <p>{error}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="inline-empty">
            <strong>No warehouses yet</strong>
            <p>Create a warehouse to organize inventory by location.</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Warehouse</th>
                  <th>Code</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <button className="entity-name" onClick={() => router.push(`/inventory/warehouses/${row.id}`)}>
                        {row.name}
                      </button>
                    </td>
                    <td>{row.code}</td>
                    <td>
                      <span className={`status-pill ${row.isActive ? "status-active" : "status-archived"}`}>
                        {row.isActive ? "Active" : "Inactive"}
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
