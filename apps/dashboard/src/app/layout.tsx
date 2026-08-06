import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/layout/sidebar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { BUSINESS_NAME } from "@/lib/branding";

export const metadata: Metadata = {
  title: "ReceptionFlow Dashboard",
  description: `Call and booking dashboard for ${BUSINESS_NAME}'s AI receptionist.`,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <MobileNav />
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
