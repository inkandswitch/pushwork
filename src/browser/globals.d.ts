/**
 * Global type declarations for browser environment
 */

// IndexedDB types
declare global {
  interface Window {
    indexedDB: IDBFactory;
    showDirectoryPicker(options?: any): Promise<any>;
    showFilePicker(options?: any): Promise<any>;
  }

  var window: Window & typeof globalThis;
  var indexedDB: IDBFactory;

  // IndexedDB interfaces
  interface IDBDatabase {
    objectStoreNames: DOMStringList;
    createObjectStore(name: string, options?: any): IDBObjectStore;
    transaction(
      storeNames: string | string[],
      mode?: "readonly" | "readwrite"
    ): IDBTransaction;
    close(): void;
  }

  interface IDBFactory {
    open(name: string, version?: number): IDBOpenDBRequest;
  }

  interface IDBRequest {
    result: any;
    error: DOMException | null;
    onsuccess: ((event: Event) => void) | null;
    onerror: ((event: Event) => void) | null;
  }

  interface IDBOpenDBRequest extends IDBRequest {
    onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null;
  }

  interface IDBVersionChangeEvent extends Event {
    target: IDBOpenDBRequest;
  }

  interface IDBObjectStore {
    put(value: any, key?: any): IDBRequest;
    get(key: any): IDBRequest;
  }

  interface IDBTransaction {
    objectStore(name: string): IDBObjectStore;
  }

  interface DOMStringList {
    contains(str: string): boolean;
  }
}

// File System Access API types
type PermissionState = "granted" | "denied" | "prompt";

interface FileSystemWritableFileStream extends WritableStream {
  write(data: any): Promise<void>;
  close(): Promise<void>;
}

export {};
