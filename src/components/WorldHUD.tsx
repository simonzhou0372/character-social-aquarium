import { ContentQueueStatus } from './ContentQueueStatus';
import { foregroundStart } from '../core/clock-presence';
import { diagnostic, diagnostics } from '../core/diagnostics';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { db } from '../data/db';
import { clockTarget, configureTime, timeSpeeds } from '../core/time';
import { calendarLimit, formatWorldTime } from '../core/calendar';
import { Button, Select, Status } from './ui';
export function WorldHUD({
  worldId,
  onToggle,
}: {
  worldId: string;
  onToggle: (running: boolean) => Promise<void>;
}) {
  const data = useLiveQuery(
    async () => ({ world: await db.worlds.get(worldId), cp: await db.checkpoints.get(worldId) }),
    [worldId],
  );
  const [now, setNow] = useState(Date.now()),
    [error, setError] = useState(''),
    [controlling, setControlling] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!data?.world || !data.cp) return null;
  const { world, cp } = data;
  const at = clockTarget(cp, now, foregroundStart());
  const lag = Math.max(0, at - cp.simTime);
  const state = diagnostics(worldId);
  diagnostic(worldId, { uiUpdatedAt: now, displayTime: at, speed: cp.speed });

  return (
    <div className="world-hud">
      <div>
        <small>
          {world.name} ·{' '}
          {cp.paused
            ? '已暂停'
            : state.phase === 'error'
              ? '调度异常'
              : cp.usageLimited
                ? '受到用量限制'
                : lag > 300000
                  ? `任务积压 ${Math.ceil(lag / 60000)} 分钟 · ${state.phase === 'api' ? 'API 等待' : cp.recoveryTarget ? '数据恢复' : '调度中'}`
                  : '运行中'}
        </small>
        <time>{formatWorldTime(world, Math.min(at, calendarLimit(world)))}</time>
      </div>
      <ContentQueueStatus worldId={worldId} />
      <Button
        aria-label={cp.paused ? '继续世界' : '暂停世界'}
        disabled={controlling}
        onClick={async () => {
          setControlling(true);
          try {
            await onToggle(cp.paused);
          } finally {
            setControlling(false);
          }
        }}
      >
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
