export type Diagnostic = {
  phase: 'idle' | 'planning' | 'api' | 'committing' | 'error';
  lastScheduledAt?: number;
  lastCommittedAt?: number;
  commitLatencyMs?: number;
  error?: string;
  uiUpdatedAt?: number;
  displayTime?: number;
  speed?: number;
  queueLength?: number;
  planningBlocked?: boolean;
};
const records = new Map<string, Diagnostic>();
export function diagnostic(worldId: string, patch: Partial<Diagnostic>) {
  if (!records.has(worldId) && records.size >= 64) records.delete(records.keys().next().value!);
  records.set(worldId, { phase: 'idle', ...records.get(worldId), ...patch });
}
export function diagnostics(worldId: string) {
  return records.get(worldId) ?? { phase: 'idle' as const };
}
// Bounded, memory-only snapshots. Inspect from devtools; no per-second database log.
if (typeof window !== 'undefined')
  Object.assign(window, { aquariumDiagnostics: () => Object.fromEntries(records) });
