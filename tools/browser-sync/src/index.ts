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
      const SimpleBrowserSyncTool = (
        await import("./components/SimpleBrowserSyncTool")
      ).default;
      return { EditorComponent: SimpleBrowserSyncTool };
    },
  },
];
