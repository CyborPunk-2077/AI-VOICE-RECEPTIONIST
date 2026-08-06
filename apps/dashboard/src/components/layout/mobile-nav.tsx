"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LayoutDashboard, PhoneCall, CalendarCheck, Settings, Sparkles } from "lucide-react";

const navItems = [
  { href: "/overview", label: "Overview", icon: LayoutDashboard },
  { href: "/calls", label: "Calls", icon: PhoneCall },
  { href: "/appointments", label: "Appointments", icon: CalendarCheck },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function MobileNav() {
  const pathname = usePathname();

  return (
    <div className="flex flex-col border-b border-border bg-card md:hidden">
      <div className="flex h-14 items-center gap-2 px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-accent-foreground">
          <Sparkles size={14} />
        </div>
        <span className="text-sm font-semibold tracking-tight">ReceptionFlow</span>
      </div>
      <nav className="flex gap-1 overflow-x-auto px-3 pb-2">
        {navItems.map((item) => {
          const active = pathname?.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium",
                active ? "bg-accent-soft text-accent" : "text-muted-foreground hover:bg-muted"
              )}
            >
              <Icon size={15} />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
