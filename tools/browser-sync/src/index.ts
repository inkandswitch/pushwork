import "./polyfills";
import { type Plugin } from "@patchwork/sdk";
import type { FolderDoc } from "./types";

import "./styles.css";

export const plugins: Plugin<any>[] = [
  {
    type: "patchwork:tool",
    id: "browser-folder-sync",
    name: "Browser Sync",
    icon: "FolderSync",
    supportedDataTypes: ["folder"],
    async load() {
      const BrowserSyncTool = (await import("./components/BrowserSyncTool"))
        .default;
      return { EditorComponent: BrowserSyncTool };
    },
  },
];
