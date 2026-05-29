// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.

import { FormEvent, ReactNode, useState } from "react";
import { Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getCurrentPhone,
  normalizePhone,
  setCurrentPhone,
} from "@/lib/user-session";

interface UserPhoneGateProps {
  children: ReactNode;
}

export function UserPhoneGate({ children }: UserPhoneGateProps) {
  const [phone, setPhone] = useState(() => getCurrentPhone() ?? "");
  const [error, setError] = useState<string | null>(null);
  const hasPhone = !!getCurrentPhone();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const normalized = normalizePhone(phone);
    if (!normalized) {
      setError("请输入有效的手机号");
      return;
    }

    try {
      setCurrentPhone(normalized);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "手机号保存失败");
    }
  };

  if (hasPhone) {
    return <>{children}</>;
  }

  return (
    <div className="h-screen w-screen bg-background">
      <Dialog open onOpenChange={() => undefined}>
        <DialogContent className="max-w-sm" onInteractOutside={(event) => event.preventDefault()}>
          <form onSubmit={handleSubmit} className="space-y-5">
            <DialogHeader>
              <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Phone className="h-5 w-5" />
              </div>
              <DialogTitle>请输入手机号</DialogTitle>
              <DialogDescription>
                当前链接未携带 phone 参数，需要手机号用于加载对应的数据空间。
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              <Label htmlFor="session-phone">手机号</Label>
              <Input
                id="session-phone"
                type="password"
                autoFocus
                inputMode="tel"
                autoComplete="tel"
                placeholder="xxxxxxxxxxx"
                value={phone}
                onChange={(event) => {
                  setPhone(event.target.value);
                  setError(null);
                }}
                aria-invalid={!!error}
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>

            <DialogFooter>
              <Button type="submit" className="w-full">
                进入
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
