"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewInventoryItemPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", sku: "", type: "PRODUCT" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          sku: form.sku || undefined,
          type: form.type,
          unitId: "00000000-0000-4000-8000-000000000001",
        }),
      });
      const body = await response.json();
      if (!response.ok || !body.success) {
        throw new Error(body.error?.message || "Unable to create item");
      }
      router.push("/inventory/items");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create item");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page-content">
      <div className="business-header">
        <div>
          <p className="eyebrow">ITEM MASTER</p>
          <h1>Create item</h1>
        </div>
      </div>
      <form className="form-section" onSubmit={submit}>
        <div className="form-grid">
          <label>
            Name
            <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </label>
          <label>
            SKU
            <input value={form.sku} onChange={(event) => setForm({ ...form, sku: event.target.value })} />
          </label>
          <label>
            Type
            <select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
              <option value="PRODUCT">PRODUCT</option>
              <option value="SERVICE">SERVICE</option>
              <option value="RAW_MATERIAL">RAW_MATERIAL</option>
              <option value="CONSUMABLE">CONSUMABLE</option>
              <option value="RENTAL_ASSET">RENTAL_ASSET</option>
              <option value="NON_STOCK">NON_STOCK</option>
            </select>
          </label>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <button type="button" className="button button-outline" onClick={() => router.push("/inventory/items")}>Cancel</button>
          <button type="submit" className="button button-primary" disabled={submitting}>{submitting ? "Creating..." : "Create item"}</button>
        </div>
      </form>
    </div>
  );
}
