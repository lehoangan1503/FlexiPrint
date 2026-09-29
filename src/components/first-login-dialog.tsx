"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Loader2, Smile } from "lucide-react";

interface FirstLoginDialogProps {
  open: boolean;
  onComplete: (nickname: string | null) => void;
}

export function FirstLoginDialog({ open, onComplete }: FirstLoginDialogProps) {
  const [nickname, setNickname] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const trimmed = nickname.trim();
    if (!trimmed) return handleSkip();

    setSaving(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: trimmed }),
      });
      if (!res.ok) throw new Error("Failed");
      onComplete(trimmed);
    } catch {
      alert("Không thể lưu biệt danh, vui lòng thử lại");
    } finally {
      setSaving(false);
    }
  }

  function handleSkip() {
    onComplete(null);
  }

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent className="sm:max-w-md" hideClose>
        <DialogHeader>
          <div className="flex items-center justify-center mb-2">
            <div className="flex items-center justify-center w-12 h-12 rounded-full bg-primary/10">
              <Smile className="h-6 w-6 text-primary" />
            </div>
          </div>
          <DialogTitle className="text-center text-xl">Chào mừng!</DialogTitle>
          <DialogDescription className="text-center">
            Hãy đặt biệt danh để đồng đội dễ nhận ra bạn hơn. Bạn có thể thay đổi biệt danh bất cứ lúc nào.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 mt-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="first-login-nickname">Biệt danh của bạn</Label>
            <Input
              id="first-login-nickname"
              placeholder="Nhập biệt danh..."
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              maxLength={50}
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
              autoFocus
            />
          </div>

          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={handleSkip} disabled={saving}>
              Bỏ qua
            </Button>
            <Button className="flex-1" onClick={handleSave} disabled={saving || !nickname.trim()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Lưu biệt danh"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
