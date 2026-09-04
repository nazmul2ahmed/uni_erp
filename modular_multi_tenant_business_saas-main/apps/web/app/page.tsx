"use client";

import { Activity, ArrowUpRight, CircleDollarSign, Package, Users } from "lucide-react";
import { ErpShell } from "@/components/layout/erp-shell";
import { Card, EmptyState } from "@/components/ui/primitives";

const metrics = [
  { label: "Today's sales", value: "BDT 0.00", change: "No sales recorded", icon: CircleDollarSign, tone: "green" },
  { label: "Customer due", value: "BDT 0.00", change: "No outstanding balance", icon: Users, tone: "blue" },
  { label: "Supplier due", value: "BDT 0.00", change: "No outstanding balance", icon: Activity, tone: "amber" },
  { label: "Stock value", value: "BDT 0.00", change: "Inventory not configured", icon: Package, tone: "slate" },
];

export default function HomePage() {
  return <ErpShell><div className="dashboard-grid">{metrics.map(({ label, value, change, icon: Icon, tone }) => <Card key={label} className="metric-card"><div className={`metric-icon metric-${tone}`}><Icon size={18} /></div><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><span className="metric-change">{change}</span></Card>)}</div><div className="dashboard-lower"><Card className="activity-card"><div className="card-heading"><div><h2>Recent activity</h2><p>Updates from your workspace</p></div><button className="text-button">View all <ArrowUpRight size={15} /></button></div><EmptyState icon={<Activity size={22} />} title="No activity yet" description="Your recent sales, purchases, and adjustments will appear here." /></Card><Card className="setup-card"><div className="card-heading"><div><h2>Workspace setup</h2><p>Get your business ready</p></div></div><div className="setup-progress"><span><b>0%</b> complete</span><span>0 of 4 steps</span></div><div className="progress-track"><div /></div><div className="setup-list"><div><span className="setup-number">1</span><span><strong>Add business details</strong><small>Tell us about your business</small></span></div><div><span className="setup-number">2</span><span><strong>Invite your team</strong><small>Work better together</small></span></div></div></Card></div></ErpShell>;
}
