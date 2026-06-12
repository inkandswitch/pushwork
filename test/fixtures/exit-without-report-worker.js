/**
 * Stub worker for ingest-pool tests: exits cleanly (code 0) on the first
 * message WITHOUT posting a response and WITHOUT raising an `error` event —
 * the exact scenario that used to hang `runIngestPool` forever (the pool only
 * listened for `message` and `error`).
 */
const { parentPort } = require("node:worker_threads");

parentPort.on("message", () => {
  process.exit(0);
});
