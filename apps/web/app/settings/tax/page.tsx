"use client";

import { useCallback, useEffect, useState } from "react";

type TaxProfile = { id: string; name: string; rate: string; isInclusive: boolean };
type Envelope<T> = { success: boolean; data?: T; error?: { message?: string } };

async function readApi<T>(response: Response): Promise<T> {
  const body = await response.json() as Envelope<T>;
  if (!response.ok || !body.success || body.data === undefined) {
    throw new Error(body.error?.message || "Unable to complete tax profile request");
  }
  return body.data;
}

export default function TaxSettingsPage() {
  const [profiles, setProfiles] = useState<TaxProfile[]>([]);
  const [name, setName] = useState("");
  const [rate, setRate] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setProfiles(await readApi<TaxProfile[]>(await fetch("/api/tax-profiles")));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load tax profiles");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await readApi<TaxProfile>(await fetch("/api/tax-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, rate }),
      }));
      setName("");
      setRate("");
      setSaved(true);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create tax profile");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="page-content">
      <div className="business-header">
        <div>
          <a className="back-link" href="/settings">Back to settings</a>
          <p className="eyebrow">ACCOUNTING SETTINGS</p>
          <h1>Tax profiles</h1>
          <p className="page-description">Tax is calculated by the server and added to each item&apos;s listed price.</p>
        </div>
      </div>
      <form className="form-section" onSubmit={create}>
        <div>
          <h2>Create tax profile</h2>
          <p>Profiles are tax-exclusive and immutable once created so historical rates remain traceable.</p>
        </div>
        <div className="form-grid">
          <label>Profile name<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} /></label>
          <label>Rate (%)<input inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)} required /></label>
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="form-actions">
          <span className="page-description">{saved ? "Tax profile created" : ""}</span>
          <button type="submit" className="button button-primary" disabled={saving}>{saving ? "Creating..." : "Create profile"}</button>
        </div>
      </form>
      <section className="table-panel detail-section">
        <h2>Configured profiles</h2>
        {loading ? <div className="table-loading"><div className="skeleton" /><div className="skeleton" /></div> : profiles.length === 0 ? (
          <div className="inline-empty"><strong>No tax profiles</strong><p>Items without a profile remain tax-free.</p></div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Name</th><th>Rate</th><th>Pricing</th></tr></thead>
              <tbody>{profiles.map((profile) => <tr key={profile.id}><td>{profile.name}</td><td>{profile.rate}%</td><td>{profile.isInclusive ? "Inclusive" : "Exclusive"}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
