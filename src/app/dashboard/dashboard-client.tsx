"use client";

import { useState } from "react";
import Link from "next/link";
import { Library, Printer, Sparkles } from "lucide-react";
import type { UserProfile } from "@/types/auth";
import { UserDropdown } from "@/components/user-dropdown";
import { FirstLoginDialog } from "@/components/first-login-dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { CustomizeProductList } from "../../../customize-tool/components/product-list";

export function DashboardClient({ profile, isSuperAdmin }: { profile: UserProfile; isSuperAdmin: boolean }) {
  const [askNickname, setAskNickname] = useState(!profile.nickname);
  const [current, setCurrent] = useState(profile);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b bg-card/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
          <Printer className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">FlexiPrint</h1>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/v2">
                <Sparkles className="h-4 w-4" /> Bộ nhân vật v2
              </Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/library">
                <Library className="h-4 w-4" /> Thư viện
              </Link>
            </Button>
            <ThemeToggle />
            <UserDropdown key={current.nickname ?? ""} profile={current} isSuperAdmin={isSuperAdmin} />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <CustomizeProductList currentUserId={profile.user_id} />
      </main>
      <FirstLoginDialog
        open={askNickname}
        onComplete={(nickname) => {
          setAskNickname(false);
          if (nickname) setCurrent({ ...current, nickname });
        }}
      />
    </div>
  );
}
