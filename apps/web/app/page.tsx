export default function HomePage() {
  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>ERP Platform — Phase 1 Foundation</h1>
      <p>
        Auth/Tenant/Membership/RBAC scaffold. Full UI (navigation, POS,
        dashboard, etc.) lands per <code>12_UX_SPECIFICATION.md</code> in
        Phase 2.
      </p>
      <p>Available endpoints:</p>
      <ul>
        <li>POST /api/auth/register</li>
        <li>POST /api/auth/login</li>
        <li>POST /api/auth/logout</li>
        <li>GET /api/auth/me</li>
        <li>POST /api/auth/tenant/select</li>
        <li>GET/PATCH /api/tenant/profile</li>
      </ul>
    </main>
  );
}
