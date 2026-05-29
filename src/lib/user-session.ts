// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.

/**
 * User session identity and storage namespacing.
 *
 * The hosting platform passes `?phone=...`. We persist that phone locally and
 * use it as the namespace for every user-owned store.
 */

export const PHONE_STORAGE_KEY = 'santi-current-phone';
export const USER_STORAGE_ROOT = 'users';
export const PENDING_USER_SEGMENT = '__pending__';

type StorageLike = {
  getItem: (name: string) => string | null;
  setItem: (name: string, value: string) => void;
  removeItem: (name: string) => void;
};

let initialized = false;
let currentPhone: string | null = null;

function canUseWindow(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function normalizePhone(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;

  const normalized = trimmed.startsWith('+')
    ? `+${trimmed.slice(1).replace(/\D/g, '')}`
    : trimmed.replace(/\D/g, '');

  const digitCount = normalized.replace(/\D/g, '').length;
  if (digitCount < 5 || digitCount > 20) return null;
  return normalized;
}

function readPhoneFromUrl(): string | null {
  if (!canUseWindow()) return null;

  try {
    const params = new URLSearchParams(window.location.search);
    return normalizePhone(params.get('phone'));
  } catch {
    return null;
  }
}

function clearPendingUserLocalStorageData(): void {
  if (!canUseWindow()) return;
  const prefix = `${USER_STORAGE_ROOT}/${PENDING_USER_SEGMENT}/`;
  Object.keys(window.localStorage)
    .filter((key) => key.startsWith(prefix))
    .forEach((key) => window.localStorage.removeItem(key));
}

export function getStoredPhone(): string | null {
  if (!canUseWindow()) return null;
  return normalizePhone(window.localStorage.getItem(PHONE_STORAGE_KEY));
}

export function setCurrentPhone(phone: string): string {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw new Error('请输入有效的手机号');
  }

  currentPhone = normalized;
  initialized = true;

  if (canUseWindow()) {
    window.localStorage.setItem(PHONE_STORAGE_KEY, normalized);
    clearPendingUserLocalStorageData();
  }

  return normalized;
}

export function initializeUserSessionFromUrl(): string | null {
  if (initialized) return currentPhone;

  const phoneFromUrl = readPhoneFromUrl();
  if (phoneFromUrl) {
    currentPhone = phoneFromUrl;
    if (canUseWindow()) {
      window.localStorage.setItem(PHONE_STORAGE_KEY, phoneFromUrl);
    }
  } else {
    currentPhone = getStoredPhone();
  }

  initialized = true;
  return currentPhone;
}

export function getCurrentPhone(): string | null {
  if (!initialized) {
    return initializeUserSessionFromUrl();
  }
  return currentPhone;
}

export function hasCurrentPhone(): boolean {
  return !!getCurrentPhone();
}

export function getUserStorageSegment(): string {
  const phone = getCurrentPhone();
  if (!phone) return PENDING_USER_SEGMENT;
  return encodeURIComponent(phone).replace(/[^\w.%+-]/g, '_');
}

export function getUserStoragePrefix(): string {
  return `${USER_STORAGE_ROOT}/${getUserStorageSegment()}`;
}

export function getUserScopedStorageKey(key: string): string {
  const normalizedKey = key.replace(/^\/+/, '');
  return `${getUserStoragePrefix()}/${normalizedKey}`;
}

export function stripCurrentUserStoragePrefix(key: string): string {
  const prefix = `${getUserStoragePrefix()}/`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

export function getUserScopedDatabaseName(name: string): string {
  const safeName = name.replace(/[^\w.-]/g, '_');
  return `santi_${getUserStorageSegment()}_${safeName}`;
}

export function getUserScopedMediaCategory(category: string): string {
  const normalizedCategory = category.replace(/^\/+|\/+$/g, '');
  return `${getUserStoragePrefix()}/${normalizedCategory}`;
}

export function shouldClearLocalStorageKeyForCurrentUser(key: string): boolean {
  return key.startsWith(`${getUserStoragePrefix()}/`);
}

export function clearCurrentUserLocalStorageData(): void {
  if (!canUseWindow()) return;
  const keys = Object.keys(window.localStorage).filter(shouldClearLocalStorageKeyForCurrentUser);
  keys.forEach((key) => window.localStorage.removeItem(key));
}

export const userScopedLocalStorage: StorageLike = {
  getItem: (name: string): string | null => {
    if (!canUseWindow()) return null;
    return window.localStorage.getItem(getUserScopedStorageKey(name));
  },
  setItem: (name: string, value: string): void => {
    if (!canUseWindow()) return;
    window.localStorage.setItem(getUserScopedStorageKey(name), value);
  },
  removeItem: (name: string): void => {
    if (!canUseWindow()) return;
    window.localStorage.removeItem(getUserScopedStorageKey(name));
  },
};

initializeUserSessionFromUrl();
