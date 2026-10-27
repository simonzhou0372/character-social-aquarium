import { ContentQueueStatus } from './ContentQueueStatus';
import { foregroundStart } from '../core/clock-presence';
import { diagnostic, diagnostics } from '../core/diagnostics';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { CalendarDays, Pause, Play, Radio, TimerReset } from 'lucide-react';
import { db } from '../data/db';
import { clockTarget, configureTime, timeSpeeds } from '../core/time';
import { calendarLimit, formatWorldClock, formatWorldTime, worldTime } from '../core/calendar';
import { Button, Select, Status } from './ui';
import { useUIPreferences } from './ui-preferences';
export function WorldHUD({
  worldId,
  onToggle,
}: {
  worldId: string;
  onToggle: (running: boolean) => Promise<void>;
}) {
  const { mode } = useUIPreferences();
  const data = useLiveQuery(
    async () => ({ world: await db.worlds.get(worldId), cp: await db.checkpoints.get(worldId) }),
    [worldId],
  );
  const [now, setNow] = useState(Date.now()),
    [error, setError] = useState(''),
    [controlling, setControlling] = useState(false),
    [speedFlash, setSpeedFlash] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!data?.world || !data.cp) return null;
  const { world, cp } = data;
  const at = clockTarget(cp, now, foregroundStart());
  const shown = Math.min(at, calendarLimit(world));
  const lag = Math.max(0, at - cp.simTime);
  const state = diagnostics(worldId);
  diagnostic(worldId, { uiUpdatedAt: now, displayTime: at, speed: cp.speed });
  const statusLabel = cp.paused
    ? '已暂停'
    : state.phase === 'error'
      ? '调度异常'
      : cp.usageLimited
        ? '受到用量限制'
        : lag > 300000
          ? `积压 ${Math.ceil(lag / 60000)} 分 · ${state.phase === 'api' ? 'API 等待' : '追赶中'}`
          : '运行中';
  if (mode === 'classic')
    return (
      <div className="world-hud">
        <div>
          <small>
            {world.name} · {statusLabel}
          </small>
          <time>{formatWorldTime(world, shown)}</time>
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
  const day = worldTime(world, shown);
  const dateLabel = `${world.era ?? 'AD'} ${day.year}/${String(day.month).padStart(2, '0')}/${String(day.day).padStart(2, '0')}`;
  return (
    <section
      className={`world-hud game-hud ${cp.paused ? 'is-paused' : ''}`}
      aria-label="世界时间与运行状态"
    >
      <div className="hud-world">
        <span className="hud-world-mark" aria-hidden="true">
          <i />
          <i />
          <b>{world.name.slice(0, 1)}</b>
        </span>
        <span>
          <small>OBSERVATION DECK</small>
          <strong>{world.name}</strong>
          <em>{cp.timeMode === 'real' ? 'REAL TIME' : 'GOD MODE'}</em>
        </span>
      </div>
      <div className="hud-clock" aria-live="off">
        <span className="hud-clock-rule" aria-hidden="true" />
        <div>
          <span className="hud-clock-date">
            <CalendarDays size={13} />
            {dateLabel}
          </span>
          <time key={formatWorldClock(world, shown)}>{formatWorldClock(world, shown)}</time>
          <small>
            DAY {String(Math.max(1, day.day)).padStart(2, '0')} /{' '}
            {String(day.month).padStart(2, '0')}
          </small>
        </div>
      </div>
      <div className="hud-signal">
        <span className="hud-pulse" aria-hidden="true" />
        <div>
          <small>WORLD SIGNAL</small>
          <strong>{statusLabel}</strong>
          <span>{cp.mode === 'demo' ? '演示轨道 · 本地规则' : '真实生成 · 本地优先'}</span>
        </div>
      </div>
      <div className="hud-controls">
        <ContentQueueStatus worldId={worldId} />
        <button
          className="hud-play"
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
          {cp.paused ? (
            <Play size={18} fill="currentColor" />
          ) : (
            <Pause size={18} fill="currentColor" />
          )}
          <span>{cp.paused ? '继续' : '暂停'}</span>
        </button>
        <label className={`hud-speed ${speedFlash ? 'flash' : ''}`}>
          <TimerReset size={14} />
          <Select
            aria-label="快捷世界速度"
            disabled={cp.timeMode === 'real'}
            value={cp.timeMode === 'real' ? 1 : cp.speed}
            onChange={(e) => {
              setSpeedFlash((n) => n + 1);
              window.setTimeout(() => setSpeedFlash(0), 520);
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
        </label>
      </div>
      <span className="hud-scan" aria-hidden="true" />
      {error && (
        <div className="hud-error">
          <Status error>{error}</Status>
        </div>
      )}
      <span className="hud-corner hud-corner-a" aria-hidden="true" />
      <span className="hud-corner hud-corner-b" aria-hidden="true" />
      <Radio className="hud-radio" size={14} aria-hidden="true" />
    </section>
  );
}
