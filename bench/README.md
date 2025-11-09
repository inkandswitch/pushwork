# Performance Benchmarks

Run `pnpm bench` to measure performance-critical operations. Focus on **content-similarity** (Levenshtein distance) as the primary bottleneck - 1KB files take ~10ms each to compare.
