#!/usr/bin/env node
import { runDoctor, type CheckResult } from '../src/doctor.js';

function printResults(results: CheckResult[]): void {
  console.log('검차');
  console.log('─'.repeat(30));
  for (const result of results) {
    const prefix = result.ok ? '✓' : '✗';
    console.log(`${prefix} ${result.name}: ${result.detail}`);
  }
}

async function main() {
  const results = await runDoctor();
  printResults(results);

  if (results.some((result) => !result.ok)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
