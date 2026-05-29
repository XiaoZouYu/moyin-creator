// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
import { useEffect, useState } from "react";
import { Layout } from "@/components/Layout";
import { UserPhoneGate } from "@/components/UserPhoneGate";
import { Toaster } from "@/components/ui/sonner";
import { useThemeStore } from "@/stores/theme-store";
import { useAPIConfigStore } from "@/stores/api-config-store";
import { useAppSettingsStore } from "@/stores/app-settings-store";
import { parseApiKeys } from "@/lib/api-key-manager";
import { isPricingMetadataProviderPlatform } from "@/lib/ai/provider-platforms";
import { Loader2 } from "lucide-react";
import { migrateToProjectStorage, recoverFromLegacy } from "@/lib/storage-migration";
import { getCurrentPhone } from "@/lib/user-session";

function App() {
  const { theme } = useThemeStore();
  const hasPhone = !!getCurrentPhone();
  const [isMigrating, setIsMigrating] = useState(() => hasPhone);

  // 启动时运行存储迁移 + 数据恢复
  useEffect(() => {
    if (!hasPhone) {
      setIsMigrating(false);
      return;
    }

    setIsMigrating(true);
    (async () => {
      try {
        await useAppSettingsStore.persist.rehydrate();
        await migrateToProjectStorage();
        await recoverFromLegacy();
      } catch (err) {
        console.error('[App] Migration/recovery error:', err);
      } finally {
        setIsMigrating(false);
      }
    })();
  }, [hasPhone]);

  // 启动时自动同步所有已配置 API Key 的供应商模型元数据
  useEffect(() => {
    if (!hasPhone || isMigrating) return;
    let cancelled = false;

    const runStartupSync = async () => {
      const { providers, syncProviderModels } = useAPIConfigStore.getState();
      const configuredProviders = providers
        .filter((p) => parseApiKeys(p.apiKey).length > 0)
        .sort((a, b) => Number(isPricingMetadataProviderPlatform(b.platform)) - Number(isPricingMetadataProviderPlatform(a.platform)));

      for (const p of configuredProviders) {
        if (cancelled) return;
        try {
          const result = await syncProviderModels(p.id);
          if (cancelled) return;
          if (result.success) {
            console.log(`[App] Auto-synced ${p.name}: ${result.count} models`);
          } else {
            console.warn(`[App] Auto-sync skipped for ${p.name}: ${result.error || 'unknown error'}`);
          }
        } catch (error) {
          if (!cancelled) {
            console.warn(`[App] Auto-sync failed for ${p.name}:`, error);
          }
        }
      }
    };

    void runStartupSync();

    return () => {
      cancelled = true;
    };
  }, [hasPhone, isMigrating]);

  // 同步主题到 html 元素
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(theme);
  }, [theme]);

  if (!hasPhone) {
    return (
      <>
        <UserPhoneGate>
          <Layout />
        </UserPhoneGate>
        <Toaster richColors position="top-center" />
      </>
    );
  }

  // 迁移中显示加载界面
  if (isMigrating) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">正在初始化...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden">
      <Layout />
      <Toaster richColors position="top-center" />
    </div>
  );
}

export default App;
