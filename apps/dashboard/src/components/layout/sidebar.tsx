"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { BUSINESS_NAME, BUSINESS_INITIALS } from "@/lib/branding";
import {
  LayoutDashboard,
  PhoneCall,
  CalendarCheck,
  Settings,
  Sparkles,
} from "lucide-react";

const navItems = [
  { href: "/overview", label: "Overview", icon: LayoutDashboard },
  { href: "/calls", label: "Calls", icon: PhoneCall },
  { href: "/appointments", label: "Appointments", icon: CalendarCheck },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card md:flex">
      <div className="flex h-16 items-center gap-2 px-6">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-accent-foreground">
          <Sparkles size={16} />
        </div>
        <span className="text-sm font-semibold tracking-tight">ReceptionFlow</span>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-2">
        {navItems.map((item) => {
          const active = pathname?.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-accent-soft text-accent"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <Icon size={17} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border p-4">
        <div className="flex items-center gap-3 rounded-md px-2 py-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-semibold">
            {BUSINESS_INITIALS}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{BUSINESS_NAME}</p>
            <p className="truncate text-xs text-muted-foreground">Owner account</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
