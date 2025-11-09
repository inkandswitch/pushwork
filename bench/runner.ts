#!/usr/bin/env tsx
/**
 * Benchmark runner for Pushwork performance tests
 * 
 * Run with: pnpm bench
 */

import { readdirSync } from 'fs';
import { join } from 'path';

async function main() {
  console.log('🏃 Running Pushwork Performance Benchmarks\n');
  console.log('=' .repeat(80));
  console.log();

  const benchDir = __dirname;
  const benchFiles = readdirSync(benchDir)
    .filter(f => f.endsWith('.bench.ts'))
    .sort();

  if (benchFiles.length === 0) {
    console.log('No benchmark files found');
    return;
  }

  for (const file of benchFiles) {
    const benchPath = join(benchDir, file);
    console.log(`📊 ${file.replace('.bench.ts', '')}`);
    console.log('-'.repeat(80));
    
    try {
      const module = await import(benchPath);
      // Wait for the default export promise to complete
      if (module.default) {
        await module.default;
      }
      console.log();
    } catch (error) {
      console.error(`❌ Failed to run ${file}:`, error);
      console.log();
    }
  }

  console.log('=' .repeat(80));
  console.log('✅ All benchmarks completed\n');
}

main().catch(console.error);

