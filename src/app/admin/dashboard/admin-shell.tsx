"use client";

import { usePathname } from "next/navigation";
import { ShieldCheck, Users, Package, LogOut, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { adminLogout } from "../login/actions";

interface AdminShellProps {
  email: string | null;
  children: React.ReactNode;
}

const NAV_ITEMS = [
  { href: "/admin/dashboard/accounts", label: "Quản lý tài khoản", icon: Users },
  { href: "/admin/dashboard/products", label: "Sản phẩm", icon: Package },
];

export function AdminShell({ email, children }: AdminShellProps) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-background">
      {/* Top Bar */}
      <header className="border-b bg-card px-6 py-4">
        <div className="flex items-center justify-between max-w-7xl mx-auto">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-amber-500" />
            <span className="font-semibold text-lg">FlexiPrint Admin</span>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" /> Tool
            </Link>
            {email && (
              <span className="text-sm text-muted-foreground hidden sm:block">{email}</span>
            )}
            <form action={adminLogout}>
              <Button type="submit" variant="outline" size="sm" className="flex items-center gap-2">
                <LogOut className="h-4 w-4" />
                Đăng Xuất
              </Button>
            </form>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto flex flex-col md:flex-row">
        {/* Left Nav */}
        <aside className="md:w-60 shrink-0 border-b md:border-b-0 md:border-r p-4">
          <nav className="flex md:flex-col gap-1">
            {NAV_ITEMS.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>

        {/* Content */}
        <main className="flex-1 min-w-0 px-6 py-8 flex flex-col gap-8">{children}</main>
      </div>
    </div>
  );
}
