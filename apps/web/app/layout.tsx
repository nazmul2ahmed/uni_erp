import "./globals.css";
import { AppShell } from "@/components/business/business-ui";

export const metadata = {
  title: "ERP Platform",
  description: "Modular Multi-Tenant Business ERP SaaS",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><AppShell>{children}</AppShell></body>
    </html>
  );
}
