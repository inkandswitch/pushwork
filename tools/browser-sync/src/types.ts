import { AutomergeUrl } from "@automerge/automerge-repo";

export interface FolderDoc {
  "@patchwork": { type: "folder" };
  docs: Array<{
    name: string;
    type: "file" | "folder";
    url: AutomergeUrl;
  }>;
}

export interface SyncStatus {
  isConnected: boolean;
  hasDirectoryAccess: boolean;
  lastSync: Date | null;
  filesCount: number;
  syncInProgress: boolean;
  error: string | null;
}

export interface SyncSettings {
  autoSync: boolean;
  syncInterval: number; // in seconds
  excludePatterns: string[];
  syncServerUrl: string;
  syncServerStorageId: string;
}
