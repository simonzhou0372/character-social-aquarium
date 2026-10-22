import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { db } from '../data/db';
import { clockTarget, configureTime, timeSpeeds } from '../core/time';
import { calendarLimit, formatWorldTime } from '../core/calendar';
import { Button, Select, Status } from './ui';
export function WorldHUD({ worldId, onToggle }: { worldId: string; onToggle: () => void }) {
  const data = useLiveQuery(
    async () => ({ world: await db.worlds.get(worldId), cp: await db.checkpoints.get(worldId) }),
    [worldId],
  );
  const [now, setNow] = useState(Date.now()),
    [error, setError] = useState('');
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!data?.world || !data.cp) return null;
  const { world, cp } = data;
  const at = cp.paused
    ? cp.simTime
    : (cp.recoveryTarget ??
      clockTarget(cp, now, document.hidden || !navigator.onLine ? undefined : cp.realTime));
  return (
    <div className="world-hud">
      <div>
        <small>
          {world.name} · {cp.paused ? '已暂停' : cp.usageLimited ? '受到用量限制' : '运行中'}
        </small>
        <time>{formatWorldTime(world, Math.min(at, calendarLimit(world)))}</time>
      </div>
      <Button aria-label={cp.paused ? '继续世界' : '暂停世界'} onClick={onToggle}>
        {cp.paused ? '▶' : 'Ⅱ'}
      </Button>
      <Select
        aria-label="快捷世界速度"
        disabled={cp.timeMode === 'real'}
        value={cp.timeMode === 'real' ? 1 : cp.speed}
        onChange={(e) => {
          void configureTime(worldId, cp.timeMode ?? 'god', Number(e.target.value)).catch((e) =>
            setError(String(e)),
          );
        }}
      >
        {timeSpeeds.map((v) => (
          <option key={v} value={v}>
            {v}×
          </option>
        ))}
      </Select>
      {error && <Status error>{error}</Status>}
    </div>
  );
}
