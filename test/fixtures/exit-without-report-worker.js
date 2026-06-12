/**
 * Stub shard worker for ingest-pool tests: exits cleanly (code 0) on startup
 * WITHOUT posting a report and WITHOUT raising an `error` event — the
 * worker-death scenario the shard pools must convert into per-shard task
 * failures instead of leaving the pool's promise pending.
 */
process.exit(0);
