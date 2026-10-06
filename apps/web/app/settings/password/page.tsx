"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { PasswordChangeForm } from "@/components/account/password-change-form";

function PasswordPage() {
  const forced = useSearchParams().get("required") === "1";
  // A full navigation (not router.push) so /api/auth/me and the server guards are re-evaluated with the cleared flag.
  return <main className="page-content finance-page">
    <header className="finance-header"><div><p className="eyebrow">ACCOUNT</p><h1>Password</h1></div></header>
    <PasswordChangeForm forced={forced} onChanged={() => window.location.assign("/")} />
  </main>;
}

export default function SettingsPasswordPage() {
  return <Suspense fallback={null}><PasswordPage /></Suspense>;
}
