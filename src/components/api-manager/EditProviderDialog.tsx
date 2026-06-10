// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
"use client";

/**
 * Edit Provider Dialog
 * For editing existing API providers
 */

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import type { IProvider } from "@/lib/api-key-manager";
import { getApiKeyCount } from "@/lib/api-key-manager";
import { isAgnesProvider, isFixedBaseUrlProviderPlatform, normalizeBuiltInProvider } from "@/lib/ai/provider-platforms";
import {
  VOLC_ARK_SEEDANCE_MODEL_ID,
  VOLC_ARK_VIDEO_BASE_URL,
  VOLC_ARK_VIDEO_MODEL_OPTIONS,
  isVolcArkVideoPlatform,
  normalizeVolcArkVideoModelList,
} from "@/lib/volc-ark-video";

interface EditProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: IProvider | null;
  onSave: (provider: IProvider) => void;
}

export function EditProviderDialog({
  open,
  onOpenChange,
  provider,
  onSave,
}: EditProviderDialogProps) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");

  // Initialize form when provider changes
  useEffect(() => {
    if (provider) {
      const isOfficialVolcArk = isVolcArkVideoPlatform(provider.platform);
      setName(provider.name);
      setBaseUrl(provider.baseUrl);
      setApiKey(provider.apiKey);
      setModel(isOfficialVolcArk
        ? normalizeVolcArkVideoModelList(provider.model)[0]
        : provider.model?.join(', ') || '');
    }
  }, [provider]);

  const handleSave = () => {
    if (!provider) return;
    const isOfficialVolcArk = isVolcArkVideoPlatform(provider.platform);
    const isAgnes = isAgnesProvider(provider.platform);

    if (!isAgnes && !name.trim()) {
      toast.error("请输入名称");
      return;
    }

    const models = isOfficialVolcArk
      ? [model || VOLC_ARK_SEEDANCE_MODEL_ID]
      : model
        .split(/[,\n]/)
        .map(m => m.trim())
        .filter(m => m.length > 0);

    const nextProvider = normalizeBuiltInProvider({
      ...provider,
      name: name.trim(),
      baseUrl: isOfficialVolcArk ? VOLC_ARK_VIDEO_BASE_URL : baseUrl.trim(),
      apiKey: apiKey.trim(),
      model: models,
      capabilities: isOfficialVolcArk ? ["video_generation"] : provider.capabilities,
    });

    onSave(nextProvider);

    onOpenChange(false);
    toast.success("已保存更改");
  };

  const keyCount = getApiKeyCount(apiKey);
  const hasFixedBaseUrl = isVolcArkVideoPlatform(provider?.platform)
    || isFixedBaseUrlProviderPlatform(provider?.platform);
  const hideName = isAgnesProvider(provider?.platform);
  const hideModel = hideName;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>编辑供应商</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-4">
          {/* Platform (read-only) */}
          <div className="space-y-2">
            <Label className="text-muted-foreground">平台</Label>
            <Input value={provider?.platform || ""} disabled className="bg-muted" />
          </div>

          {/* Name */}
          {!hideName && (
            <div className="space-y-2">
              <Label>名称</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="供应商名称"
              />
            </div>
          )}

          {/* Base URL */}
          {!hasFixedBaseUrl && (
            <div className="space-y-2">
              <Label>Base URL</Label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </div>
          )}

          {/* API Keys */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>API Keys</Label>
              <span className="text-xs text-muted-foreground">
                {keyCount} 个 Key
              </span>
            </div>
            <Textarea
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="输入 API Keys（每行一个，或用逗号分隔）"
              className="font-mono text-sm min-h-[100px]"
            />
            <p className="text-xs text-muted-foreground">
              💡 支持多个 Key 轮换使用，失败时自动切换到下一个
            </p>
          </div>

          {/* Model */}
          {!hideModel && (
            <div className="space-y-2">
              <Label>模型</Label>
              {isVolcArkVideoPlatform(provider?.platform) ? (
                <>
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger>
                      <SelectValue placeholder="选择火山方舟视频模型" />
                    </SelectTrigger>
                    <SelectContent>
                      {VOLC_ARK_VIDEO_MODEL_OPTIONS.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          <span className="flex flex-col text-left">
                            <span>{option.label}</span>
                            <span className="text-[11px] text-muted-foreground">{option.id}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    火山方舟视频模型使用同一组 API Key 鉴权，但账号必须已开通所选模型。
                  </p>
                </>
              ) : (
                <>
                  <Input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="输入模型名称，如 deepseek-v3"
                  />
                  <p className="text-xs text-muted-foreground">
                    多个模型用逗号分隔，第一个为默认模型
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
