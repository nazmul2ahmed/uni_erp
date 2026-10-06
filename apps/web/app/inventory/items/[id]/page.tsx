"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type TaxProfile = { id: string; name: string; rate: string };
type Item = { id: string; name: string; sku: string | null; taxProfileId: string | null };
type Envelope<T> = { success: boolean; data?: T; error?: { message?: string } };

async function readApi<T>(response: Response): Promise<T> {
  const body = await response.json() as Envelope<T>;
  if (!response.ok || !body.success || body.data === undefined) {
    throw new Error(body.error?.message || "Unable to load item");
  }
  return body.data;
}

export default function InventoryItemPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [item, setItem] = useState<Item | null>(null);
  const [profiles, setProfiles] = useState<TaxProfile[]>([]);
  const [taxProfileId, setTaxProfileId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      fetch(`/api/items/${params.id}`).then(readApi<Item>),
      fetch("/api/tax-profiles").then(readApi<TaxProfile[]>),
    ])
      .then(([itemRow, taxProfiles]) => {
        setItem(itemRow);
        setTaxProfileId(itemRow.taxProfileId ?? "");
        setProfiles(taxProfiles);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load item settings"))
      .finally(() => setLoading(false));
  }, [params.id]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const updated = await readApi<Item>(await fetch(`/api/items/${params.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taxProfileId: taxProfileId || null }),
      }));
      setItem(updated);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update item tax profile");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="page-content"><div className="form-loading"><div className="skeleton" /></div></div>;
  if (!item) return <div className="page-content"><div className="inline-error"><strong>Unable to load item</strong><p>{error}</p><button className="button button-outline" onClick={() => router.push("/inventory/items")}>Back to items</button></div></div>;

  return (
    <div className="page-content">
      <div className="business-header">
        <div>
          <button className="back-link" onClick={() => router.push("/inventory/items")}>Back to items</button>
          <p className="eyebrow">ITEM MASTER</p>
          <h1>{item.name}</h1>
          <p className="page-description">{item.sku || "No SKU"} · Tax is added to the listed price.</p>
        </div>
      </div>
      <form className="form-section" onSubmit={save}>
        <h2>Tax assignment</h2>
        <div className="form-grid">
          <label>
            Tax profile
            <select value={taxProfileId} onChange={(event) => { setTaxProfileId(event.target.value); setSaved(false); }}>
              <option value="">No tax</option>
              {profiles.map((profile) => (
                <option value={profile.id} key={profile.id}>{profile.name} ({profile.rate}%)</option>
              ))}
            </select>
          </label>
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="form-actions">
          <span className="page-description">{saved ? "Tax profile saved" : ""}</span>
          <button type="submit" className="button button-primary" disabled={saving}>
            {saving ? "Saving..." : "Save tax profile"}
          </button>
        </div>
      </form>
    </div>
  );
}
