// Offline comparison: input files are arrays of exported usageLedger rows or full backups.
// No API calls, no secrets, no prompt text in output.
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';
const [before, after, output] = process.argv.slice(2);
if (!before || !after)
  throw new Error(
    'Usage: node scripts/compare-cache-runs.mjs before.json after.json [report.json]',
  );
const rows = (path) => {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  const list = Array.isArray(value) ? value : (value.usageLedger ?? value.data?.usageLedger);
  if (!Array.isArray(list)) throw new Error('Missing usageLedger array: ' + path);
  return list;
};
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { compareCacheRuns } = await server.ssrLoadModule('/src/ai/cache-statistics.ts');
  const result = JSON.stringify(compareCacheRuns(rows(before), rows(after)), null, 2) + '\n';
  if (output) writeFileSync(output, result);
  else process.stdout.write(result);
} finally {
  await server.close();
}
