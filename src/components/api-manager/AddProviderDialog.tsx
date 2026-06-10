// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
"use client";

/**
 * Add Provider Dialog
 * For adding new API providers with platform selection
 */

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import type { IProvider, ModelCapability } from "@/lib/api-key-manager";
import {
  AGNES_BASE_URL,
  AGNES_DEFAULT_MODELS,
  AGNES_NAME,
  AGNES_PLATFORM,
  AUTO_VIP_BASE_URL,
  AUTO_VIP_NAME,
  AUTO_VIP_PLATFORM,
  CHUNFENG_BASE_URL,
  CHUNFENG_NAME,
  CHUNFENG_PLATFORM,
} from "@/lib/ai/provider-platforms";
import {
  VOLC_ARK_SEEDANCE_DISPLAY_NAME,
  VOLC_ARK_SEEDANCE_MODEL_ID,
  VOLC_ARK_VIDEO_MODEL_OPTIONS,
  VOLC_ARK_VIDEO_BASE_URL,
  VOLC_ARK_VIDEO_NAME,
  VOLC_ARK_VIDEO_PLATFORM,
  isVolcArkVideoPlatform,
} from "@/lib/volc-ark-video";

/**
 * 平台预设配置
 * 1. 春风 / auto-vip - 内置 OpenAI 兼容中转
 * 2. RunningHub - 视角切换/多角度生成
 * 3. 自定义 - OpenAI 兼容 API
 */
const PLATFORM_PRESETS: Array<{
  platform: string;
  name: string;
  baseUrl: string;
  description: string;
  services: string[];
  models: string[];
  recommended?: boolean;
  capabilities?: ModelCapability[];
  allowMultiple?: boolean;
  hideBaseUrl?: boolean;
  hideName?: boolean;
  hideModel?: boolean;
  modelLabel?: string;
  modelOptions?: typeof VOLC_ARK_VIDEO_MODEL_OPTIONS;
}> = [
  {
    platform: CHUNFENG_PLATFORM,
    name: CHUNFENG_NAME,
    baseUrl: CHUNFENG_BASE_URL,
    description: "春风 OpenAI 官方兼容中转，只需填写 API Key",
    services: ["对话", "图片生成", "图片理解"],
    models: [],
    recommended: true,
    allowMultiple: true,
    hideBaseUrl: true,
    hideModel: true,
  },
  {
    platform: AGNES_PLATFORM,
    name: AGNES_NAME,
    baseUrl: AGNES_BASE_URL,
    description: "Agnes AI 官方兼容接口，支持对话、图片生成和视频生成，只需填写 API Key",
    services: ["对话", "图片生成", "视频生成"],
    models: [...AGNES_DEFAULT_MODELS],
    capabilities: ["text", "image_generation", "video_generation"],
    allowMultiple: true,
    hideBaseUrl: true,
    hideName: true,
    hideModel: true,
  },
  {
    platform: AUTO_VIP_PLATFORM,
    name: AUTO_VIP_NAME,
    baseUrl: AUTO_VIP_BASE_URL,
    description: "auto-vip 中转，使用项目内置的生图/对话流程",
    services: ["对话", "图片生成", "视频生成", "图片理解"],
    models: [],
    allowMultiple: true,
    hideBaseUrl: true,
    hideModel: true,
  },
  {
    platform: VOLC_ARK_VIDEO_PLATFORM,
    name: VOLC_ARK_VIDEO_NAME,
    baseUrl: VOLC_ARK_VIDEO_BASE_URL,
    description: "火山方舟官方 Seedance 视频生成直连，不走 AI 中转",
    services: ["视频生成"],
    models: [VOLC_ARK_SEEDANCE_MODEL_ID],
    recommended: true,
    capabilities: ["video_generation"],
    allowMultiple: true,
    hideBaseUrl: true,
    modelLabel: VOLC_ARK_SEEDANCE_DISPLAY_NAME,
    modelOptions: VOLC_ARK_VIDEO_MODEL_OPTIONS,
  },
  {
    platform: "runninghub",
    name: "RunningHub",
    baseUrl: "https://www.runninghub.cn/openapi/v2",
    description: "Qwen 视角切换 / 多角度生成",
    services: ["视角切换", "图生图"],
    models: ["2009613632530812930"],
  },
  {
    platform: "custom",
    name: "自定义",
    baseUrl: "",
    description: "自定义 OpenAI 兼容 API 供应商",
    services: [],
    models: [],
  },
];

interface AddProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (provider: Omit<IProvider, "id">) => void;
  existingPlatforms?: string[];
}

export function AddProviderDialog({
  open,
  onOpenChange,
  onSubmit,
  existingPlatforms = [],
}: AddProviderDialogProps) {
  const [platform, setPlatform] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");

  // Get selected preset
  const selectedPreset = PLATFORM_PRESETS.find((p) => p.platform === platform);
  const isCustom = platform === "custom";
  const hideBaseUrl = !!selectedPreset?.hideBaseUrl;
  const hideName = !!selectedPreset?.hideName;
  const hideModel = !!selectedPreset?.hideModel;
  const isOfficialVolcArk = isVolcArkVideoPlatform(platform);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setPlatform("");
      setName("");
      setBaseUrl("");
      setApiKey("");
      setModel("");
    }
  }, [open]);

  // Auto-fill when platform changes
  useEffect(() => {
    if (!selectedPreset) return;
    if (isCustom) {
      setName("");
      setBaseUrl("");
      setModel("");
      return;
    }

    setName(selectedPreset.name);
    setBaseUrl(selectedPreset.baseUrl);
    setModel(selectedPreset.models?.[0] || "");
  }, [platform, selectedPreset, isCustom]);

  const handleSubmit = () => {
    if (!platform) {
      toast.error("请选择平台");
      return;
    }
    if (!hideName && !name.trim()) {
      toast.error("请输入名称");
      return;
    }
    if (isCustom && !baseUrl.trim()) {
      toast.error("自定义平台需要输入 Base URL");
      return;
    }
    if (!apiKey.trim()) {
      toast.error("请输入 API Key");
      return;
    }

    // 保存该平台的所有预设模型，确保 provider.model 不为空
    const presetModels = selectedPreset?.models || [];
    const typedModels = model
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
    const modelArray = hideModel
      ? presetModels
      : isOfficialVolcArk
        ? [model || presetModels[0] || VOLC_ARK_SEEDANCE_MODEL_ID]
        : (typedModels.length > 0 ? typedModels : presetModels);
    
    onSubmit({
      platform,
      name: (name || selectedPreset?.name || platform).trim(),
      baseUrl: ((hideBaseUrl ? selectedPreset?.baseUrl : baseUrl) || "").trim(),
      apiKey: apiKey.trim(),
      model: modelArray,
      capabilities: selectedPreset?.capabilities,
    });

    onOpenChange(false);
    toast.success(`已添加 ${(name || selectedPreset?.name || platform).trim()}`);
  };

  // Filter out already existing platforms except repeatable presets.
  const availablePlatforms = PLATFORM_PRESETS.filter(
    (p) => p.platform === "custom" || p.allowMultiple || !existingPlatforms.includes(p.platform)
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>添加 API 供应商</DialogTitle>
          <DialogDescription className="hidden">添加一个新的 API 供应商</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-4">
          {/* Platform Selection */}
          <div className="space-y-2">
            <Label>平台</Label>
            <Select value={platform} onValueChange={setPlatform}>
              <SelectTrigger>
                <SelectValue placeholder="选择平台" />
              </SelectTrigger>
              <SelectContent>
              {availablePlatforms.map((preset) => (
                  <SelectItem key={preset.platform} value={preset.platform}>
                    <span className="flex items-center gap-2">
                      {preset.name}
                      {preset.recommended && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-orange-500/10 text-orange-600 dark:text-orange-400 rounded font-medium">
                          推荐
                        </span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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

          {/* Base URL (only for custom or editable) */}
          {(isCustom || platform) && !hideBaseUrl && (
            <div className="space-y-2">
              <Label>Base URL {!isCustom && "(可选修改)"}</Label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={isCustom ? "https://api.example.com/v1" : ""}
              />
            </div>
          )}

          {/* API Key */}
          <div className="space-y-2">
            <Label>API Key</Label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="输入 API Key"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              支持多个 Key，用逗号分隔
            </p>
          </div>

          {/* Model - optional input */}
          {!hideModel && (
            <div className="space-y-2">
              <Label>{selectedPreset?.modelLabel ? `模型（${selectedPreset.modelLabel}）` : "模型 (可选)"}</Label>
              {isOfficialVolcArk && selectedPreset?.modelOptions ? (
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择火山方舟视频模型" />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedPreset.modelOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        <span className="flex flex-col text-left">
                          <span>{option.label}</span>
                          <span className="text-[11px] text-muted-foreground">{option.id}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="输入模型名称，如 gpt-4o"
                />
              )}
              {isOfficialVolcArk && selectedPreset?.modelOptions && (
                <p className="text-xs text-muted-foreground">
                  火山方舟视频模型使用同一组 API Key 鉴权，但账号必须已开通所选模型。
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSubmit}>添加</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
