/**
 * Polyfills for browser APIs required by @automerge/automerge-subduction.
 * Must be imported before any subduction code.
 *
 * The Subduction WASM module uses IndexedDB for key persistence
 * (via WebCryptoSigner). In Node.js we provide a fake-indexeddb polyfill.
 */
import "fake-indexeddb/auto";
