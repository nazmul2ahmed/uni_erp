import { Package, Boxes, Warehouse, ArrowUpDown, TrendingDown } from "lucide-react";

const cards = [
  { label: "Total items", value: "0", icon: Package },
  { label: "Total stock quantity", value: "0", icon: Boxes },
  { label: "Warehouses", value: "0", icon: Warehouse },
  { label: "Adjustments", value: "0", icon: ArrowUpDown },
  { label: "Low stock", value: "0", icon: TrendingDown },
];

export default function InventoryOverviewPage() {
  return (
    <div className="page-content">
      <div className="business-header">
        <div>
          <p className="eyebrow">INVENTORY</p>
          <h1>Overview</h1>
          <p className="page-description">Operational stock visibility for your active tenant.</p>
        </div>
      </div>
      <div className="detail-grid">
        {cards.map(({ label, value, icon: Icon }) => (
          <section className="detail-card" key={label}>
            <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between" }}>
              <div>
                <p style={{ color: "#687780", fontSize: 12, margin: 0 }}>{label}</p>
                <h2 style={{ fontSize: 28, margin: "8px 0 0" }}>{value}</h2>
              </div>
              <div style={{ alignItems: "center", background: "#e9f2ef", borderRadius: 8, display: "flex", height: 42, justifyContent: "center", width: 42 }}>
                <Icon size={18} color="#176b5b" />
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
