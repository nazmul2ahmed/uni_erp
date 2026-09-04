"use client";

import { AlertCircle, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/primitives";

type Profile = { name: string; phone: string | null; address: string | null };
type Envelope<T> = { success: boolean; data?: T; error?: { message?: string } };

export default function SettingsPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void fetch("/api/tenant/profile").then((response) => response.json() as Promise<Envelope<Profile>>).then((body) => { if (!body.success || !body.data) throw new Error(body.error?.message || "Unable to load settings"); setProfile(body.data); }).catch((err) => setError(err instanceof Error ? err.message : "Unable to load settings")); }, []);
  return <main className="page-content"><div className="business-header"><div><p className="eyebrow">ADMINISTRATION</p><h1>Settings</h1><p className="page-description">Manage the active business profile.</p></div></div>{error ? <div className="inline-error" role="alert"><AlertCircle size={20} /><strong>Settings unavailable</strong><p>{error}</p></div> : !profile ? <div className="finance-loading"><LoaderCircle className="spin" size={22} />Loading settings</div> : <Card className="settings-panel"><h2>{profile.name}</h2><dl><dt>Phone</dt><dd>{profile.phone || "Not provided"}</dd><dt>Address</dt><dd>{profile.address || "Not provided"}</dd></dl></Card>}</main>;
}