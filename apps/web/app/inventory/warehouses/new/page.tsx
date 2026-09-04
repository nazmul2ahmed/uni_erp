"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewWarehousePage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", code: "", branchId: "00000000-0000-4000-8000-000000000001" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/warehouses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          code: form.code,
          branchId: form.branchId,
          isActive: true,
        }),
      });
      const body = await response.json();
      if (!response.ok || !body.success) {
        throw new Error(body.error?.message || "Unable to create warehouse");
      }
      router.push("/inventory/warehouses");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create warehouse");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page-content">
      <div className="business-header">
        <div>
          <p className="eyebrow">WAREHOUSES</p>
          <h1>Create warehouse</h1>
        </div>
      </div>
      <form className="form-section" onSubmit={submit}>
        <div className="form-grid">
          <label>
            Name
            <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </label>
          <label>
            Code
            <input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
          </label>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <button type="button" className="button button-outline" onClick={() => router.push("/inventory/warehouses")}>Cancel</button>
          <button type="submit" className="button button-primary" disabled={submitting}>{submitting ? "Creating..." : "Create warehouse"}</button>
        </div>
      </form>
    </div>
  );
}
