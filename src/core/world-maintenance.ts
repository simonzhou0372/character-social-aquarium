import { db, type AquariumDB, withWorldLock } from '../data/db';
import { processBackfill } from './backfill';
import { processReports } from './reports';
import { evaluateEvolution } from './evolution';
import { liveProvider } from '../ai/orchestrator';
export async function maintainWorld(worldId: string, d: AquariumDB = db) {
  return withWorldLock('maintenance:' + worldId, async () => {
    const cp = await d.checkpoints.get(worldId);
    if (!cp || cp.paused || (await d.worlds.get(worldId))?.deletedAt) return;
    await processBackfill(worldId, d);
    await processReports(worldId, d);
    const world = await d.worlds.get(worldId);
    if (world?.evolutionSettings?.enabled)
      await evaluateEvolution(worldId, d, cp.mode === 'live' ? await liveProvider(d) : undefined);
  });
}
