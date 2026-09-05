"use client";

import { AlertCircle, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/primitives";

type Profile = { name: string; phone: string | null; address: string | null; businessType: string };
type Envelope<T> = { success: boolean; data?: T; error?: { message?: string } };

export default function SettingsPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => { void fetch("/api/tenant/profile").then((response) => response.json() as Promise<Envelope<Profile>>).then((body) => { if (!body.success || !body.data) throw new Error(body.error?.message || "Unable to load settings"); setProfile(body.data); }).catch((err) => setError(err instanceof Error ? err.message : "Unable to load settings")); }, []);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!profile) return;
    setSaving(true); setSaved(false); setError(null);
    try {
      const response = await fetch("/api/tenant/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profile) });
      const body = await response.json() as Envelope<Profile>;
      if (!response.ok || !body.success || !body.data) throw new Error(body.error?.message || "Unable to save settings");
      setProfile(body.data); setSaved(true);
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to save settings"); }
    finally { setSaving(false); }
  };
  return <main className="page-content"><div className="business-header"><div><p className="eyebrow">ADMINISTRATION</p><h1>Settings</h1><p className="page-description">Manage the active business profile.</p></div></div>{error && <div className="form-error" role="alert"><AlertCircle size={17} />{error}</div>}{!profile ? <div className="finance-loading"><LoaderCircle className="spin" size={22} />Loading settings</div> : <form className="form-section settings-panel" onSubmit={save}><div><h2>Business profile</h2><p>Keep the workspace identity and contact details up to date.</p></div><div className="form-grid"><label>Business name<input value={profile.name} onChange={(event) => { setProfile({ ...profile, name: event.target.value }); setSaved(false); }} required /></label><label>Business type<select value={profile.businessType} onChange={(event) => { setProfile({ ...profile, businessType: event.target.value }); setSaved(false); }}><option value="RETAIL">Retail</option><option value="WHOLESALE">Wholesale</option><option value="PHARMACY">Pharmacy</option><option value="ELECTRONICS">Electronics</option><option value="DECORATOR">Decorator</option><option value="SERVICE">Service</option><option value="MANUFACTURING">Manufacturing</option><option value="RENTAL">Rental</option><option value="OTHER">Other</option></select></label><label>Phone<input value={profile.phone || ""} onChange={(event) => { setProfile({ ...profile, phone: event.target.value }); setSaved(false); }} /></label><label className="wide">Address<textarea rows={3} value={profile.address || ""} onChange={(event) => { setProfile({ ...profile, address: event.target.value }); setSaved(false); }} /></label></div><div className="form-actions"><span className="page-description">{saved ? "Changes saved" : ""}</span><button className="button button-primary" disabled={saving}>{saving && <LoaderCircle className="spin" size={15} />}{saving ? "Saving..." : "Save changes"}</button></div></form>}</main>;
}