# Browser Folder Sync - Patchwork Tool

A patchwork tool that enables synchronizing local folders with Patchwork documents using the Chrome File System Access API.

## Features

- **📂 Folder Selection**: Native browser folder picker with persistent access
- **🔄 Real-time Sync**: Manual sync with visual progress indicators
- **📋 File Listing**: Browse files and folders with size information
- **⚙️ Configurable Settings**: Auto-sync, exclude patterns, sync intervals
- **🛡️ Permission Management**: Proper handling of File System Access API permissions
- **🎨 Modern UI**: Clean, responsive interface with status indicators

## Browser Support

This tool requires browsers that support the File System Access API:

- ✅ Chrome 86+
- ✅ Edge 86+
- ✅ Safari 15.2+ (limited support)
- ❌ Firefox (not supported yet)

## Usage

1. **Load the Tool**: The tool appears as "Browser Sync" for folder documents in Patchwork
2. **Select Folder**: Click "Select Folder" to choose a local directory
3. **Grant Permissions**: Allow the browser to access the selected folder
4. **Sync Files**: Use "Sync Now" for manual synchronization
5. **Configure Settings**: Toggle auto-sync and adjust settings as needed

## Technical Implementation

### Architecture

```
Browser Sync Tool
├── SimpleBrowserSyncTool.tsx    # Main React component
├── polyfills.ts                 # Node.js browser compatibility
├── types.ts                     # TypeScript interfaces
└── styles.css                   # Tool styling
```

### Key Technologies

- **File System Access API**: Native browser folder access
- **React**: Component-based UI framework
- **Patchwork SDK**: Integration with Patchwork platform
- **Automerge**: CRDT-based document synchronization
- **Vite**: Modern build tooling with browser optimization

### Browser Polyfills

The tool includes comprehensive polyfills for Node.js globals:

- `process` object with environment variables
- `Buffer` minimal implementation
- `global` reference for compatibility

### Build Configuration

Vite configuration excludes Node.js modules and provides browser-safe aliases:

- Disabled: `fs`, `path`, `crypto`, `glob`, and other Node.js modules
- Polyfilled: `process`, `Buffer`, `global`
- Optimized: ES2022 target with tree-shaking

## Current Limitations

1. **Demo Implementation**: Sync functionality is currently simulated
2. **Basic File Listing**: No recursive directory traversal
3. **No Real Persistence**: Changes aren't actually synced to Automerge docs
4. **Simple UI**: Basic interface without advanced features

## Future Enhancements

To complete the full pushwork integration:

1. **Real Sync Engine**: Integrate with pushwork's browser sync engine
2. **Change Detection**: Implement file modification monitoring
3. **Conflict Resolution**: Add CRDT-based merge capabilities
4. **Performance**: Optimize for large directories
5. **Advanced UI**: Add progress bars, conflict indicators, etc.

## Development

### Build Commands

```bash
# Install dependencies
pnpm install

# Build for production
pnpm run build

# Watch mode (with auto-push to Patchwork)
pnpm run watch
```

### Project Structure

```
tools/browser-sync/
├── dist/                    # Built output
├── src/
│   ├── components/
│   │   └── SimpleBrowserSyncTool.tsx
│   ├── polyfills.ts
│   ├── types.ts
│   ├── index.ts
│   └── styles.css
├── package.json
├── vite.config.ts
└── patchwork.json
```

This tool demonstrates the foundation for browser-based file synchronization and can be extended to provide full pushwork compatibility for web-based collaborative editing.
