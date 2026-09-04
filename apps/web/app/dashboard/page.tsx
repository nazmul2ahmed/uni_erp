"use client";

import { Activity, CircleDollarSign, Package, ShoppingCart, Users } from "lucide-react";
import { Card } from "@/components/ui/primitives";

const cards = [
  { label: "Today's sales", value: "BDT 0.00", icon: CircleDollarSign, description: "Live dashboard data will connect when reporting endpoints are available." },
  { label: "Today's purchases", value: "BDT 0.00", icon: ShoppingCart, description: "Live dashboard data will connect when reporting endpoints are available." },
  { label: "Customer due", value: "BDT 0.00", icon: Users, description: "Receivables summary is not available yet." },
  { label: "Supplier due", value: "BDT 0.00", icon: Activity, description: "Payables summary is not available yet." },
  { label: "Current stock value", value: "BDT 0.00", icon: Package, description: "Inventory reporting is not available yet." },
];

export default function DashboardPage() {
  return <div className="page-content"><div className="business-header"><div><p className="eyebrow">OVERVIEW</p><h1>Dashboard</h1><p className="page-description">Overview of your business.</p></div></div><div className="dashboard-grid">{cards.map(({ label, value, icon: Icon, description }) => <Card className="metric-card" key={label}><div className="metric-icon metric-green"><Icon size={18} /></div><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><span className="metric-change">{description}</span></Card>)}</div><div className="dashboard-lower"><Card className="activity-card"><h2>Recent sales</h2><p className="page-description">No business activity yet.</p><div className="inline-empty"><ShoppingCart size={22} /><strong>No recent sales</strong><p>Sales activity will appear here when the Sales module is available.</p></div></Card><Card className="activity-card"><h2>Recent purchases</h2><p className="page-description">No business activity yet.</p><div className="inline-empty"><Package size={22} /><strong>No recent purchases</strong><p>Purchase activity will appear here when the Purchases module is available.</p></div></Card></div></div>;
}