// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.

import { corsFetch } from '@/lib/cors-fetch';
import { normalizeNetworkErrorMessage } from '@/lib/network-error';
import { useAppSettingsStore } from '@/stores/app-settings-store';

export type BackendGenerationKind = 'image' | 'video' | 'audio' | 'media';

export type BackendGenerationTaskStatus =
  | 'queued'
  | 'submitting'
  | 'polling'
  | 'ingesting'
  | 'completed'
  | 'failed'
  | 'timeout';

export type BackendGenerationFormField = {
  name: string;
  value?: string;
  fileName?: string;
  mimeType?: string;
  dataBase64?: string;
};

export type BackendGenerationRequestSpec = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  formData?: BackendGenerationFormField[];
  intervalMs?: number;
  requestTimeoutMs?: number;
};

export type BackendGenerationTaskInput = {
  kind: BackendGenerationKind;
  label?: string;
  timeoutMs?: number;
  submitTimeoutMs?: number;
  submitRetries?: number;
  submit: BackendGenerationRequestSpec;
  poll?: BackendGenerationRequestSpec;
  parse?: {
    taskIdPaths?: string[];
    statusPaths?: string[];
    resultUrlPaths?: string[];
    errorPaths?: string[];
    successStatuses?: string[];
    failureStatuses?: string[];
  };
  result?: {
    mediaKind?: BackendGenerationKind;
    storageKey?: string;
    fallbackUrl?: string;
    ingest?: boolean;
  };
};

export type BackendGenerationTaskSnapshot = {
  id: string;
  kind: BackendGenerationKind;
  label?: string;
  status: BackendGenerationTaskStatus;
  progress: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  timeoutMs: number;
  upstreamTaskId?: string;
  upstreamStatus?: string;
  result?: {
    url?: string;
    mediaUrl?: string;
    mediaKey?: string;
    mimeType?: string;
    size?: number;
    ingestError?: string;
  };
  error?: string;
};

const TERMINAL_STATUSES = new Set<BackendGenerationTaskStatus>(['completed', 'failed', 'timeout']);

export function getBackendPollingTimeoutMs(): number {
  const minutes = useAppSettingsStore.getState().backendPolling.maxDurationMinutes;
  const safeMinutes = Number.isFinite(minutes) ? Math.max(1, Math.min(60, minutes)) : 10;
  return safeMinutes * 60 * 1000;
}

export function getBackendTaskResultUrl(task: BackendGenerationTaskSnapshot): string {
  return task.result?.mediaUrl || task.result?.url || '';
}

async function readTaskResponse(response: Response, operation: string): Promise<BackendGenerationTaskSnapshot> {
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      const data = JSON.parse(text) as { detail?: unknown; error?: unknown };
      detail = String(data.detail || data.error || text);
    } catch {
      // Use raw text.
    }
    throw new Error(`${operation}失败：HTTP ${response.status}${detail ? `，${detail}` : ''}`);
  }
  return JSON.parse(text) as BackendGenerationTaskSnapshot;
}

export async function createBackendGenerationTask(
  input: BackendGenerationTaskInput,
): Promise<BackendGenerationTaskSnapshot> {
  try {
    const timeoutMs = input.timeoutMs ?? getBackendPollingTimeoutMs();
    const response = await corsFetch('/__generation_tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...input,
        timeoutMs,
        submitTimeoutMs: input.submitTimeoutMs ?? timeoutMs,
      }),
    });
    return readTaskResponse(response, '后端生成任务创建');
  } catch (error) {
    throw new Error(normalizeNetworkErrorMessage(error, '后端生成任务创建'));
  }
}

export async function getBackendGenerationTask(
  taskId: string,
): Promise<BackendGenerationTaskSnapshot> {
  try {
    const response = await corsFetch(`/__generation_tasks/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: { 'Cache-Control': 'no-cache' },
    });
    return readTaskResponse(response, '后端生成任务状态读取');
  } catch (error) {
    throw new Error(normalizeNetworkErrorMessage(error, `后端生成任务状态读取（${taskId}）`));
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('用户已取消'));
      return;
    }
    const timeout = window.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timeout);
      reject(new Error('用户已取消'));
    }, { once: true });
  });
}

function backendTaskWaitDeadlineMs(createdAt?: number, timeoutMs?: number): number {
  const taskTimeout = Number.isFinite(timeoutMs) && timeoutMs ? timeoutMs : getBackendPollingTimeoutMs();
  const startedAt = Number.isFinite(createdAt) && createdAt ? createdAt : Date.now();
  return startedAt + taskTimeout + 30_000;
}

export async function waitForBackendGenerationTask(
  taskId: string,
  options: {
    signal?: AbortSignal;
    intervalMs?: number;
    onProgress?: (progress: number, task: BackendGenerationTaskSnapshot) => void;
  } = {},
): Promise<BackendGenerationTaskSnapshot> {
  const intervalMs = Math.max(1000, options.intervalMs || 2000);
  let lastReadError: unknown;
  let deadlineMs = Date.now() + getBackendPollingTimeoutMs() + 30_000;

  while (!options.signal?.aborted) {
    let task: BackendGenerationTaskSnapshot;
    try {
      task = await getBackendGenerationTask(taskId);
      lastReadError = undefined;
      deadlineMs = backendTaskWaitDeadlineMs(task.createdAt, task.timeoutMs);
    } catch (error) {
      lastReadError = error;
      if (Date.now() >= deadlineMs) {
        throw new Error(normalizeNetworkErrorMessage(
          lastReadError,
          `后端生成任务状态读取连续失败（${taskId}）`,
        ));
      }
      await wait(intervalMs, options.signal);
      continue;
    }

    options.onProgress?.(task.progress, task);

    if (task.status === 'completed') return task;
    if (task.status === 'failed' || task.status === 'timeout') {
      throw new Error(task.error || `后端生成任务${task.status === 'timeout' ? '超时' : '失败'}`);
    }

    await wait(intervalMs, options.signal);
  }

  throw new Error('用户已取消');
}

export async function runBackendGenerationTask(
  input: BackendGenerationTaskInput,
  options: {
    signal?: AbortSignal;
    intervalMs?: number;
    onProgress?: (progress: number, task: BackendGenerationTaskSnapshot) => void;
  } = {},
): Promise<BackendGenerationTaskSnapshot> {
  const created = await createBackendGenerationTask(input);
  options.onProgress?.(created.progress, created);
  if (TERMINAL_STATUSES.has(created.status)) {
    if (created.status === 'completed') return created;
    throw new Error(created.error || '后端生成任务失败');
  }
  return waitForBackendGenerationTask(created.id, options);
}

export function defaultGenerationParse(kind: BackendGenerationKind): BackendGenerationTaskInput['parse'] {
  return {
    statusPaths: [
      'status',
      'state',
      'task_status',
      'data.status',
      'data.task_status',
      'output.task_status',
      'output.status',
    ],
    resultUrlPaths: kind === 'video'
      ? [
          'data.0.url',
          'data.url',
          'data.video_url',
          'data.task_result.videos.0.url',
          'output.video_url',
          'output.url',
          'content.video_url',
          'result.video_url',
          'result.url',
          'video_url',
          'videoUrl',
          'result_url',
          'url',
        ]
      : [
          'data.0.url',
          'data.0.image_url',
          'data.url',
          'data.image_url',
          'data.result.images.0.url',
          'result.images.0.url',
          'output_url',
          'result_url',
          'image_url',
          'imageUrl',
          'url',
        ],
  };
}
