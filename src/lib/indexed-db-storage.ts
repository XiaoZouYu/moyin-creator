// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * File Storage Adapter for Zustand
 * Uses the active Web file storage adapter and falls back to localStorage.
 */

import type { StateStorage } from 'zustand/middleware';
import {
  getUserScopedStorageKey,
  stripCurrentUserStoragePrefix,
  userScopedLocalStorage,
} from './user-session';

// Type declarations for the fileStorage API installed by web-platform.ts.
declare global {
  interface Window {
    fileStorage?: {
      getItem: (key: string) => Promise<string | null>;
      setItem: (key: string, value: string) => Promise<boolean>;
      removeItem: (key: string) => Promise<boolean>;
      exists: (key: string) => Promise<boolean>;
      listKeys: (prefix: string) => Promise<string[]>;
      listDirs: (prefix: string) => Promise<string[]>;
      removeDir: (prefix: string) => Promise<boolean>;
    };
  }
}

const hasPlatformFileStorage = (): boolean => {
  return typeof window !== 'undefined' && !!window.fileStorage;
};

// Check if data has meaningful content (not just empty state)
const hasRichData = (jsonStr: string | null): boolean => {
  if (!jsonStr) return false;
  try {
    const data = JSON.parse(jsonStr);
    const state = data.state || data;
    
    // Check common store patterns for meaningful data
    if (state.projects && Array.isArray(state.projects) && state.projects.length > 1) return true;
    if (state.splitScenes && Array.isArray(state.splitScenes) && state.splitScenes.length > 0) return true;
    if (state.scenes && Array.isArray(state.scenes) && state.scenes.length > 0) return true;
    if (state.episodes && Array.isArray(state.episodes) && state.episodes.length > 0) return true;
    if (state.characters && Array.isArray(state.characters) && state.characters.length > 0) return true;
    if (state.media && Array.isArray(state.media) && state.media.length > 0) return true;
    
    // For director store, check nested project data
    if (state.projects && typeof state.projects === 'object') {
      for (const projectId of Object.keys(state.projects)) {
        const proj = state.projects[projectId];
        if (proj.splitScenes && proj.splitScenes.length > 0) return true;
        if (proj.screenplay) return true;
      }
    }
    
    // Check data size as fallback (more than 1KB likely has real data)
    return jsonStr.length > 1000;
  } catch {
    return jsonStr.length > 1000;
  }
};

export const fileStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    const scopedName = getUserScopedStorageKey(name);
    console.log(`[Storage] getItem: ${name}, scoped: ${scopedName}, platformFileStorage: ${hasPlatformFileStorage()}`);
    if (hasPlatformFileStorage()) {
      try {
        // Get data from all sources
        const fileData = await window.fileStorage!.getItem(scopedName);
        const localData = userScopedLocalStorage.getItem(name);
        let idbData: string | null = null;
        try {
          idbData = await getFromIndexedDB(scopedName);
        } catch (e) {
          // IndexedDB not available
        }
        
        console.log(`[Storage] Data sizes for ${name}: file=${fileData?.length || 0}, local=${localData?.length || 0}, idb=${idbData?.length || 0}`);
        
        // Determine which data source has the richest data
        const fileHasData = hasRichData(fileData);
        const localHasData = hasRichData(localData);
        const idbHasData = hasRichData(idbData);
        
        console.log(`[Storage] Rich data check for ${name}: file=${fileHasData}, local=${localHasData}, idb=${idbHasData}`);
        
        // Priority: localStorage > IndexedDB > file (for migration)
        // If localStorage or IndexedDB has richer data, migrate it
        if (localHasData && !fileHasData) {
          console.log(`[Storage] Migrating ${name} from localStorage to platform file storage (richer data)...`);
          await window.fileStorage!.setItem(scopedName, localData!);
          userScopedLocalStorage.removeItem(name);
          console.log(`[Storage] Migration complete for ${name}`);
          return localData;
        }
        
        if (idbHasData && !fileHasData && !localHasData) {
          console.log(`[Storage] Migrating ${name} from IndexedDB to platform file storage (richer data)...`);
          await window.fileStorage!.setItem(scopedName, idbData!);
          await removeFromIndexedDB(scopedName);
          console.log(`[Storage] Migration complete for ${name}`);
          return idbData;
        }
        
        // Clean up old data if file storage has the data
        if (fileHasData) {
          if (localData) {
            console.log(`[Storage] Cleaning up localStorage for ${name}`);
            userScopedLocalStorage.removeItem(name);
          }
          if (idbData) {
            console.log(`[Storage] Cleaning up IndexedDB for ${name}`);
            await removeFromIndexedDB(scopedName);
          }
          return fileData;
        }
        
        // Return whatever we have
        return fileData || localData || idbData || null;
      } catch (error) {
        console.error('File storage getItem error:', error);
      }
    }
    // Fallback to localStorage.
    return userScopedLocalStorage.getItem(name);
  },

  setItem: async (name: string, value: string): Promise<void> => {
    const scopedName = getUserScopedStorageKey(name);
    console.log(`[Storage] setItem: ${name}, scoped: ${scopedName}, size: ${value.length} chars, platformFileStorage: ${hasPlatformFileStorage()}`);
    if (hasPlatformFileStorage()) {
      try {
        const result = await window.fileStorage!.setItem(scopedName, value);
        console.log(`[Storage] File save result for ${name}:`, result);
        return;
      } catch (error) {
        console.error('[Storage] File storage setItem error:', error);
      }
    }
    // Fallback to localStorage
    try {
      userScopedLocalStorage.setItem(name, value);
    } catch (error) {
      console.error('localStorage setItem error:', error);
    }
  },

  removeItem: async (name: string): Promise<void> => {
    const scopedName = getUserScopedStorageKey(name);
    if (hasPlatformFileStorage()) {
      try {
        await window.fileStorage!.removeItem(scopedName);
        return;
      } catch (error) {
        console.error('File storage removeItem error:', error);
      }
    }
    userScopedLocalStorage.removeItem(name);
  },
};

export async function fileStorageExists(name: string): Promise<boolean> {
  const scopedName = getUserScopedStorageKey(name);
  if (hasPlatformFileStorage() && window.fileStorage?.exists) {
    return window.fileStorage.exists(scopedName);
  }
  return userScopedLocalStorage.getItem(name) !== null;
}

export async function fileStorageListKeys(prefix: string): Promise<string[]> {
  const scopedPrefix = getUserScopedStorageKey(prefix).replace(/\/+$/g, '');
  if (hasPlatformFileStorage() && window.fileStorage?.listKeys) {
    const keys = await window.fileStorage.listKeys(scopedPrefix);
    return keys.map(stripCurrentUserStoragePrefix);
  }

  const start = `${scopedPrefix}/`;
  return Object.keys(localStorage)
    .filter((key) => key === scopedPrefix || key.startsWith(start))
    .map(stripCurrentUserStoragePrefix);
}

export async function fileStorageListDirs(prefix: string): Promise<string[]> {
  const scopedPrefix = getUserScopedStorageKey(prefix).replace(/\/+$/g, '');
  if (hasPlatformFileStorage() && window.fileStorage?.listDirs) {
    return window.fileStorage.listDirs(scopedPrefix);
  }

  const start = `${scopedPrefix}/`;
  const dirs = new Set<string>();
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(start)) continue;
    const first = key.slice(start.length).split('/')[0];
    if (first && first !== '_migrated') dirs.add(first);
  }
  return [...dirs];
}

export async function fileStorageRemoveDir(prefix: string): Promise<boolean> {
  const scopedPrefix = getUserScopedStorageKey(prefix).replace(/\/+$/g, '');
  if (hasPlatformFileStorage() && window.fileStorage?.removeDir) {
    return window.fileStorage.removeDir(scopedPrefix);
  }

  const start = `${scopedPrefix}/`;
  Object.keys(localStorage)
    .filter((key) => key === scopedPrefix || key.startsWith(start))
    .forEach((key) => localStorage.removeItem(key));
  return true;
}

// Helper to get data from IndexedDB (for migration)
const getFromIndexedDB = (name: string): Promise<string | null> => {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open('santi-creator-db', 1);
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('zustand-storage')) {
          resolve(null);
          return;
        }
        const transaction = db.transaction('zustand-storage', 'readonly');
        const store = transaction.objectStore('zustand-storage');
        const getRequest = store.get(name);
        getRequest.onerror = () => resolve(null);
        getRequest.onsuccess = () => resolve(getRequest.result ?? null);
      };
    } catch {
      resolve(null);
    }
  });
};

const removeFromIndexedDB = (name: string): Promise<void> => {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open('santi-creator-db', 1);
      request.onerror = () => resolve();
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('zustand-storage')) {
          resolve();
          return;
        }
        const transaction = db.transaction('zustand-storage', 'readwrite');
        const store = transaction.objectStore('zustand-storage');
        store.delete(name);
        resolve();
      };
    } catch {
      resolve();
    }
  });
};

// Migration helper (kept for backward compatibility, but migration now happens in getItem)
export const migrateFromLocalStorage = async (_key: string): Promise<void> => {
  // Migration now happens automatically in fileStorage.getItem
};

// For backward compatibility
export const indexedDBStorage = fileStorage;
