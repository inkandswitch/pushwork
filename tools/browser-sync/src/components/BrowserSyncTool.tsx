import React, { useState, useEffect, useRef } from "react";
import { useDocHandle } from "@automerge/automerge-repo-react-hooks";
import { EditorProps } from "@patchwork/sdk";
import {
  FolderOpen,
  RefreshCw,
  Settings,
  AlertCircle,
  CheckCircle,
  Clock,
  File,
  Folder,
  Upload,
} from "lucide-react";
import { FolderDoc, SyncStatus, SyncSettings } from "../types";
import {
  createBrowserSync,
  isFileSystemAccessSupported,
} from "pushwork/dist/browser";

interface BrowserSyncState {
  syncInstance: any;
  directoryHandle: any;
  status: SyncStatus;
  settings: SyncSettings;
  files: Array<{
    name: string;
    type: "file" | "directory";
    size?: number;
    lastModified?: Date;
  }>;
  showSettings: boolean;
}

const BrowserSyncTool: React.FC<EditorProps<FolderDoc, unknown>> = ({
  docUrl,
}) => {
  const handle = useDocHandle<FolderDoc>(docUrl);
  const [state, setState] = useState<BrowserSyncState>({
    syncInstance: null,
    directoryHandle: null,
    status: {
      isConnected: false,
      hasDirectoryAccess: false,
      lastSync: null,
      filesCount: 0,
      syncInProgress: false,
      error: null,
    },
    settings: {
      autoSync: false,
      syncInterval: 30,
      excludePatterns: [".git", "node_modules", "*.tmp", ".pushwork"],
      syncServerUrl: "wss://sync3.automerge.org",
      syncServerStorageId: "3760df37-a4c6-4f66-9ecd-732039a9385d",
    },
    files: [],
    showSettings: false,
  });

  const autoSyncInterval = useRef<NodeJS.Timeout | null>(null);

  // Initialize sync instance on mount
  useEffect(() => {
    const initializeSync = async () => {
      try {
        const syncInstance = await createBrowserSync({
          syncServerUrl: state.settings.syncServerUrl,
          syncServerStorageId: state.settings.syncServerStorageId,
        });

        setState((prev) => ({
          ...prev,
          syncInstance,
          status: { ...prev.status, isConnected: true },
        }));
      } catch (error) {
        setState((prev) => ({
          ...prev,
          status: {
            ...prev.status,
            error: `Failed to initialize sync: ${error}`,
          },
        }));
      }
    };

    initializeSync();
  }, []);

  // Setup auto-sync if enabled
  useEffect(() => {
    if (
      state.settings.autoSync &&
      state.syncInstance &&
      state.directoryHandle
    ) {
      autoSyncInterval.current = setInterval(() => {
        handleSync();
      }, state.settings.syncInterval * 1000);
    } else if (autoSyncInterval.current) {
      clearInterval(autoSyncInterval.current);
      autoSyncInterval.current = null;
    }

    return () => {
      if (autoSyncInterval.current) {
        clearInterval(autoSyncInterval.current);
      }
    };
  }, [
    state.settings.autoSync,
    state.settings.syncInterval,
    state.syncInstance,
    state.directoryHandle,
  ]);

  const handleSelectFolder = async () => {
    if (!state.syncInstance) {
      setState((prev) => ({
        ...prev,
        status: { ...prev.status, error: "Sync instance not initialized" },
      }));
      return;
    }

    try {
      setState((prev) => ({
        ...prev,
        status: { ...prev.status, error: null },
      }));

      const directoryHandle = await state.syncInstance.pickFolder();

      // Get initial file list
      const statusResult = await state.syncInstance.getStatus();

      setState((prev) => ({
        ...prev,
        directoryHandle,
        status: {
          ...prev.status,
          hasDirectoryAccess: true,
          filesCount: statusResult.browserState?.rootHandle ? 1 : 0,
        },
      }));

      // Load file list
      await updateFileList();
    } catch (error) {
      setState((prev) => ({
        ...prev,
        status: {
          ...prev.status,
          error: `Failed to select folder: ${error}`,
          hasDirectoryAccess: false,
        },
      }));
    }
  };

  const updateFileList = async () => {
    if (!state.syncInstance || !state.directoryHandle) return;

    try {
      const filesystem = state.syncInstance.filesystem;
      const entries = await filesystem.listDirectory(
        state.directoryHandle,
        true,
        state.settings.excludePatterns
      );

      const files = entries.map((entry: any) => ({
        name: entry.path,
        type: entry.type === "directory" ? "directory" : "file",
        size: entry.size,
        lastModified: entry.mtime,
      }));

      setState((prev) => ({
        ...prev,
        files,
        status: { ...prev.status, filesCount: files.length },
      }));
    } catch (error) {
      console.error("Failed to update file list:", error);
    }
  };

  const handleSync = async () => {
    if (!state.syncInstance || !state.directoryHandle) {
      setState((prev) => ({
        ...prev,
        status: { ...prev.status, error: "No folder selected" },
      }));
      return;
    }

    setState((prev) => ({
      ...prev,
      status: { ...prev.status, syncInProgress: true, error: null },
    }));

    try {
      const result = await state.syncInstance.sync();

      setState((prev) => ({
        ...prev,
        status: {
          ...prev.status,
          syncInProgress: false,
          lastSync: new Date(),
          error: result.success
            ? null
            : `Sync failed: ${result.errors
                .map((e: any) => e.error.message)
                .join(", ")}`,
        },
      }));

      if (result.success) {
        await updateFileList();
      }
    } catch (error) {
      setState((prev) => ({
        ...prev,
        status: {
          ...prev.status,
          syncInProgress: false,
          error: `Sync failed: ${error}`,
        },
      }));
    }
  };

  const handleSettingsChange = (key: keyof SyncSettings, value: any) => {
    setState((prev) => ({
      ...prev,
      settings: { ...prev.settings, [key]: value },
    }));
  };

  const formatFileSize = (bytes?: number): string => {
    if (!bytes) return "";
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  };

  if (!isFileSystemAccessSupported()) {
    return (
      <div className="browser-sync-tool">
        <div className="empty-state">
          <AlertCircle className="empty-state-icon" />
          <h3 className="empty-state-title">
            File System Access Not Supported
          </h3>
          <p className="empty-state-description">
            Your browser doesn't support the File System Access API. Please use
            a modern browser like Chrome, Edge, or Safari.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="browser-sync-tool">
      <div className="browser-sync-header">
        <h1 className="browser-sync-title">Browser Folder Sync</h1>
        <p className="browser-sync-subtitle">
          Synchronize a local folder with this Patchwork document
        </p>
      </div>

      <div className="browser-sync-content">
        <div className="browser-sync-main">
          {/* Status Card */}
          <div className="status-card">
            <div className="status-header">
              <div
                className={`status-indicator ${
                  state.status.hasDirectoryAccess && state.status.isConnected
                    ? "connected"
                    : state.status.syncInProgress
                    ? "pending"
                    : "disconnected"
                }`}
              />
              <h3 className="status-title">Sync Status</h3>
            </div>

            <div style={{ marginBottom: "0.5rem" }}>
              <strong>Connection:</strong>{" "}
              {state.status.isConnected ? "Connected" : "Disconnected"}
            </div>
            <div style={{ marginBottom: "0.5rem" }}>
              <strong>Folder Access:</strong>{" "}
              {state.status.hasDirectoryAccess ? "Granted" : "Not selected"}
            </div>
            <div style={{ marginBottom: "0.5rem" }}>
              <strong>Files:</strong> {state.status.filesCount}
            </div>
            {state.status.lastSync && (
              <div style={{ marginBottom: "0.5rem" }}>
                <strong>Last Sync:</strong>{" "}
                {state.status.lastSync.toLocaleString()}
              </div>
            )}
          </div>

          {/* Error Message */}
          {state.status.error && (
            <div className="error-message">
              <AlertCircle
                style={{
                  width: "16px",
                  height: "16px",
                  display: "inline",
                  marginRight: "0.5rem",
                }}
              />
              {state.status.error}
            </div>
          )}

          {/* Sync Progress */}
          {state.status.syncInProgress && (
            <div className="sync-progress">
              <RefreshCw
                className="sync-spinner"
                style={{ width: "16px", height: "16px" }}
              />
              Synchronizing files...
            </div>
          )}

          {/* Main Actions */}
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
            <button
              className="button primary"
              onClick={handleSelectFolder}
              disabled={state.status.syncInProgress}
            >
              <FolderOpen style={{ width: "16px", height: "16px" }} />
              {state.status.hasDirectoryAccess
                ? "Change Folder"
                : "Select Folder"}
            </button>

            <button
              className="button"
              onClick={handleSync}
              disabled={
                !state.status.hasDirectoryAccess || state.status.syncInProgress
              }
            >
              <RefreshCw style={{ width: "16px", height: "16px" }} />
              Sync Now
            </button>

            <button
              className="button"
              onClick={() =>
                setState((prev) => ({
                  ...prev,
                  showSettings: !prev.showSettings,
                }))
              }
            >
              <Settings style={{ width: "16px", height: "16px" }} />
              Settings
            </button>
          </div>

          {/* File List */}
          {state.files.length > 0 ? (
            <div>
              <h3
                style={{
                  marginBottom: "0.5rem",
                  fontSize: "1rem",
                  fontWeight: "500",
                }}
              >
                Files ({state.files.length})
              </h3>
              <div className="file-list">
                {state.files.slice(0, 50).map((file, index) => (
                  <div key={index} className="file-item">
                    {file.type === "directory" ? (
                      <Folder className="file-icon" />
                    ) : (
                      <File className="file-icon" />
                    )}
                    <span className="file-name">{file.name}</span>
                    {file.size && (
                      <span className="file-size">
                        {formatFileSize(file.size)}
                      </span>
                    )}
                  </div>
                ))}
                {state.files.length > 50 && (
                  <div
                    className="file-item"
                    style={{ fontStyle: "italic", color: "#6b7280" }}
                  >
                    ... and {state.files.length - 50} more files
                  </div>
                )}
              </div>
            </div>
          ) : state.status.hasDirectoryAccess ? (
            <div className="empty-state">
              <Upload className="empty-state-icon" />
              <h3 className="empty-state-title">No Files Found</h3>
              <p className="empty-state-description">
                The selected folder appears to be empty or all files are
                excluded.
              </p>
            </div>
          ) : (
            <div className="empty-state">
              <FolderOpen className="empty-state-icon" />
              <h3 className="empty-state-title">No Folder Selected</h3>
              <p className="empty-state-description">
                Choose a folder from your computer to start syncing files.
              </p>
            </div>
          )}
        </div>

        {/* Settings Panel */}
        {state.showSettings && (
          <div className="settings-panel">
            <h3
              style={{
                marginBottom: "1rem",
                fontSize: "1rem",
                fontWeight: "500",
              }}
            >
              Settings
            </h3>

            <div className="settings-row">
              <label className="settings-label">Auto Sync</label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={state.settings.autoSync}
                  onChange={(e) =>
                    handleSettingsChange("autoSync", e.target.checked)
                  }
                />
                <span className="toggle-slider"></span>
              </label>
            </div>

            {state.settings.autoSync && (
              <div className="settings-row">
                <label className="settings-label">
                  Sync Interval (seconds)
                </label>
                <input
                  type="number"
                  value={state.settings.syncInterval}
                  onChange={(e) =>
                    handleSettingsChange(
                      "syncInterval",
                      parseInt(e.target.value)
                    )
                  }
                  min="5"
                  max="300"
                  style={{
                    width: "80px",
                    padding: "0.25rem",
                    border: "1px solid #d1d5db",
                    borderRadius: "0.25rem",
                  }}
                />
              </div>
            )}

            <div className="settings-row">
              <label className="settings-label">Exclude Patterns</label>
              <input
                type="text"
                value={state.settings.excludePatterns.join(", ")}
                onChange={(e) =>
                  handleSettingsChange(
                    "excludePatterns",
                    e.target.value.split(",").map((s) => s.trim())
                  )
                }
                placeholder=".git, node_modules, *.tmp"
                style={{
                  flex: 1,
                  marginLeft: "1rem",
                  padding: "0.25rem",
                  border: "1px solid #d1d5db",
                  borderRadius: "0.25rem",
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default BrowserSyncTool;
