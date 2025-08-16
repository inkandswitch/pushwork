import "../polyfills";
import React, { useState, useRef, useEffect } from "react";
import { useDocHandle } from "@automerge/automerge-repo-react-hooks";
import { EditorProps } from "@patchwork/sdk";
// Simple browser-only sync - no pushwork imports needed
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

interface BrowserSyncState {
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

const SimpleBrowserSyncTool: React.FC<EditorProps<FolderDoc, unknown>> = ({
  docUrl,
}) => {
  const handle = useDocHandle<FolderDoc>(docUrl);

  // Debug logging
  console.log("🔍 SimpleBrowserSyncTool initialized with:", {
    docUrl,
    handle,
    doc: handle?.doc(),
    isReady: handle?.isReady(),
  });
  const [state, setState] = useState<BrowserSyncState>({
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

  // Monitor document readiness
  useEffect(() => {
    console.log("📡 Handle changed:", {
      handle,
      doc: handle?.doc(),
    });
  }, [handle]);

  const isFileSystemAccessSupported = (): boolean => {
    try {
      const hasAPI =
        typeof window !== "undefined" &&
        typeof (window as any).showDirectoryPicker === "function";
      // Note: We only need showDirectoryPicker for folder sync, not showFilePicker

      // File System Access API requires HTTPS or localhost
      const isSecureContext =
        window.isSecureContext ||
        window.location.protocol === "https:" ||
        window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1";

      return hasAPI && isSecureContext;
    } catch (error) {
      console.error("Error checking File System Access API support:", error);
      return false;
    }
  };

  const handleSelectFolder = async () => {
    if (!isFileSystemAccessSupported()) {
      setState((prev) => ({
        ...prev,
        status: {
          ...prev.status,
          error: "File System Access API not supported",
        },
      }));
      return;
    }

    try {
      setState((prev) => ({
        ...prev,
        status: { ...prev.status, error: null },
      }));

      console.log("📁 Opening directory picker...");
      const directoryHandle = await (window as any).showDirectoryPicker({
        mode: "readwrite",
        id: "pushwork-sync-folder",
      });

      console.log("✅ Directory selected:", directoryHandle.name);
      console.log("🔍 Directory handle details:", directoryHandle);

      setState((prev) => ({
        ...prev,
        directoryHandle,
        status: {
          ...prev.status,
          hasDirectoryAccess: true,
          isConnected: true,
        },
      }));

      // Load file list
      await updateFileList(directoryHandle);
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

  const updateFileList = async (directoryHandle: any) => {
    if (!directoryHandle) return;

    try {
      const files: any[] = [];

      // Simple directory listing without recursion for demo
      for await (const [name, handle] of directoryHandle.entries()) {
        if (handle.kind === "file") {
          const file = await handle.getFile();
          files.push({
            name,
            type: "file",
            size: file.size,
            lastModified: new Date(file.lastModified),
          });
        } else if (handle.kind === "directory") {
          files.push({
            name,
            type: "directory",
            size: 0,
            lastModified: new Date(),
          });
        }
      }

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
    if (!state.directoryHandle) {
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
      console.log("🔄 Starting simple browser sync...");
      console.log("📁 Directory handle:", state.directoryHandle);
      console.log("📄 Patchwork doc URL:", docUrl);

      if (!handle?.doc()) {
        throw new Error("No Patchwork document available");
      }

      // Read files from the directory using File System Access API
      const entries: Array<{
        name: string;
        type: "file" | "folder";
        url?: string;
      }> = [];

      for await (const [name, entryHandle] of state.directoryHandle.entries()) {
        console.log(`📂 Found: ${name} (${entryHandle.kind})`);

        if (entryHandle.kind === "file") {
          entries.push({
            name,
            type: "file",
            url: `file://${name}`, // Placeholder URL - in real implementation would create actual Automerge file docs
          });
        } else {
          entries.push({
            name,
            type: "folder",
            url: `folder://${name}`, // Placeholder URL - in real implementation would create actual Automerge folder docs
          });
        }
      }

      console.log(`📊 Found ${entries.length} items in directory`);

      // Update the Patchwork document with proper folder structure
      handle.change((doc: FolderDoc) => {
        // Ensure proper patchwork folder structure
        if (!doc["@patchwork"]) {
          doc["@patchwork"] = { type: "folder" };
        }
        if (!doc.docs) {
          doc.docs = [];
        }

        // Clear and rebuild the docs array
        doc.docs = entries.map((entry) => ({
          name: entry.name,
          type: entry.type,
          url: entry.url as any, // Type assertion for the placeholder URLs
        }));

        console.log(
          `✅ Updated Patchwork document with ${entries.length} entries`
        );
        console.log("📄 Document structure:", doc);
      });

      setState((prev) => ({
        ...prev,
        status: {
          ...prev.status,
          syncInProgress: false,
          lastSync: new Date(),
          error: null,
          filesCount: entries.length,
        },
      }));

      await updateFileList(state.directoryHandle);
    } catch (error) {
      console.error("❌ Simple sync failed:", error);
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
    const hasAPI = typeof (window as any).showDirectoryPicker === "function";
    const isSecureContext =
      window.isSecureContext ||
      window.location.protocol === "https:" ||
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";

    let errorMessage = "";
    let suggestion = "";

    if (!hasAPI) {
      errorMessage = "File System Access API Not Available";
      suggestion =
        "Please use Chrome 86+, Edge 86+, or Safari 15.2+. Firefox doesn't support this API yet.";
    } else if (!isSecureContext) {
      errorMessage = "Secure Context Required";
      suggestion =
        "The File System Access API requires HTTPS or localhost. Please use https:// or run on localhost.";
    } else {
      errorMessage = "File System Access Not Supported";
      suggestion =
        "Your browser configuration doesn't allow File System Access.";
    }

    return (
      <div className="browser-sync-tool">
        <div className="empty-state">
          <AlertCircle className="empty-state-icon" />
          <h3 className="empty-state-title">{errorMessage}</h3>
          <p className="empty-state-description">{suggestion}</p>
          <div
            style={{ marginTop: "1rem", fontSize: "0.75rem", color: "#9ca3af" }}
          >
            <strong>Debug Info:</strong>
            <br />
            Browser: {navigator.userAgent.split(" ").slice(-2).join(" ")}
            <br />
            Protocol: {window.location.protocol}
            <br />
            Host: {window.location.hostname}
            <br />
            Secure Context: {isSecureContext ? "Yes" : "No"}
            <br />
            API Available: {hasAPI ? "Yes" : "No"}
          </div>
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

export default SimpleBrowserSyncTool;
