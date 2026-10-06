"use client";

import { LogOut } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { PasswordChangeForm } from "@/components/account/password-change-form";

function AccountPage() {
  const forced = useSearchParams().get("required") === "1";
  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  };
  return <div className="app-main" style={{ minHeight: "100vh" }}>
    <header className="app-topbar">
      <span className="topbar-context">Platform administration<small>  Account</small></span>
      <div className="topbar-user">{!forced && <a className="topbar-action" href="/platform">Overview</a>}<button className="topbar-action" onClick={() => void signOut()}><LogOut size={15} />Sign out</button></div>
    </header>
    <main className="page-content finance-page">
      <PasswordChangeForm forced={forced} onChanged={() => window.location.assign("/platform")} />
    </main>
  </div>;
}

export default function PlatformAccountPage() {
  return <Suspense fallback={null}><AccountPage /></Suspense>;
}
