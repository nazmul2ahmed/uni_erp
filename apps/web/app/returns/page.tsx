"use client";

import { useEffect, useState } from "react";

type ReturnRow = { id: string; type: string; saleId: string | null; purchaseId: string | null; grandTotal: string; returnDate: string; status: string };

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(body.error?.message || "Unable to load returns");
  return body.data as T;
}

export default function ReturnsPage() {
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api<ReturnRow[]>("/api/returns").then(setRows).catch((err) => setError(err instanceof Error ? err.message : "Unable to load returns")); }, []);
  return <main className="page-content"><header className="business-header"><div><p className="eyebrow">RETURNS</p><h1>Returns history</h1><p className="page-description">Posted customer and supplier returns with their source transaction references.</p></div></header><section className="table-panel">{error ? <div className="inline-error"><strong>Returns are unavailable</strong><p>{error}</p></div> : rows.length === 0 ? <div className="inline-empty"><strong>No returns posted</strong><p>Completed returns will appear here after a server-side transaction.</p></div> : <div className="table-scroll"><table><thead><tr><th>Type</th><th>Source</th><th>Date</th><th>Total</th><th>Status</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{row.type.replaceAll("_", " ")}</td><td>{row.saleId || row.purchaseId || "-"}</td><td>{new Date(row.returnDate).toLocaleDateString()}</td><td>{row.grandTotal}</td><td>{row.status}</td></tr>)}</tbody></table></div>}</section></main>;
}