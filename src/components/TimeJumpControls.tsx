import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { jumpWorldTime } from '../core/time';
import { setRunning } from '../core/engine';
import { getKey } from '../ai/provider';
import { DAY, HOUR } from '../core/types';
import { formatWorldTime } from '../core/calendar';
import { Button, Input, Select, Confirm, Status } from './ui';

const jumpPresets = [
  ['+1 小时', HOUR],
  ['+3 小时', 3 * HOUR],
  ['+6 小时', 6 * HOUR],
  ['+12 小时', 12 * HOUR],
  ['+1 天', DAY],
  ['+3 天', 3 * DAY],
] as const;

export function TimeJumpControls({
  worldId,
  compact = false,
  onQueued,
}: {
  worldId: string;
  compact?: boolean;
  onQueued?: () => void;
}) {
  const data = useLiveQuery(
    async () => ({
      cp: await db.checkpoints.get(worldId),
      world: await db.worlds.get(worldId),
      profile: await db.profiles.get('api'),
    }),
    [worldId],
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [jumpNotice, setJumpNotice] = useState(''),
    [jumpHours, setJumpHours] = useState(6),
    [jumpUnit, setJumpUnit] = useState<'hour' | 'day'>('hour'),
    [pendingJump, setPendingJump] = useState<number>();
  const cp = data?.cp;
  async function jump(ms: number) {
    if (busy || !cp) return;
    setBusy(true);
    setError('');
    setJumpNotice('');
    try {
      if (ms > 7 * DAY) throw new Error('单次最多跳转 7 天，更远的未来请分几次补全。');
      const profile = data?.profile;
      if (cp.mode === 'live' && (!profile || !getKey(profile)))
        throw new Error('真实生成需要先连接 AI；也可以先在模拟器里切到演示模式。');
      const result = await jumpWorldTime(worldId, ms);
      setJumpNotice(
        `已排队补全到 ${formatWorldTime(data!.world!, result.to)}。世界时间会先跳到目标，内容由批量补全逐步写入，期间可以收进后台。`,
      );
      setPendingJump(undefined);
      onQueued?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : '时间跳转失败');
      setPendingJump(undefined);
    } finally {
      setBusy(false);
    }
  }
  function requestJump(ms: number) {
    if (ms > DAY) setPendingJump(ms);
    else void jump(ms);
  }
  return (
    <>
      <div className={`time-jump-controls ${compact ? 'is-compact' : ''}`}>
        <div className="time-jump-head">
          <div>
            <strong>跳到之后</strong>
            <span>让 AI 用批量补全把这段时间的生活、聊天和线下场景补齐。</span>
          </div>
          <em>BATCH CATCH-UP</em>
        </div>
        <div className="time-jump-presets">
          {jumpPresets.map(([label, ms]) => (
            <Button key={label} disabled={busy} onClick={() => requestJump(ms)}>
              {label}
            </Button>
          ))}
        </div>
        <div className="time-jump-custom">
          <span>自定义</span>
          <Input
            aria-label="跳转时长"
            type="number"
            min={1}
            max={jumpUnit === 'hour' ? 168 : 7}
            value={jumpHours}
            onChange={(e) => setJumpHours(Math.max(1, Number(e.target.value) || 1))}
          />
          <Select
            aria-label="跳转单位"
            value={jumpUnit}
            onChange={(e) => setJumpUnit(e.target.value as 'hour' | 'day')}
          >
            <option value="hour">小时后</option>
            <option value="day">天后</option>
          </Select>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              requestJump(Math.min(7 * DAY, jumpHours * (jumpUnit === 'hour' ? HOUR : DAY)))
            }
          >
            跳转并补全
          </Button>
        </div>
        {cp?.jumpTarget ? (
          <div className="time-jump-active">
            <Status>
              正在补全到目标时间；已完成的批次会持续保存。
              <Button
                onClick={() =>
                  void setRunning(worldId, false, cp.mode).then(() => {
                    setJumpNotice('已取消本次跳转并暂停世界，已生成的内容保留。');
                    setPendingJump(undefined);
                  })
                }
              >
                取消跳转并暂停
              </Button>
            </Status>
          </div>
        ) : null}
        <small className="time-jump-hint">
          建议单次不超过 1 天（24 小时）。跳得越远，AI
          要生成的事件、消息和线下场景越多，等待会明显变长；最长 7
          天，超过建议分几次跳转。跳转过程中可以安全暂停，已完成批次会保留。
        </small>
        {error && <Status error>{error}</Status>}
        {jumpNotice && <Status>{jumpNotice}</Status>}
      </div>
      {pendingJump && (
        <Confirm
          title="一次补全超过 24 小时？"
          confirmLabel="仍然跳转"
          onClose={() => setPendingJump(undefined)}
          onConfirm={() => void jump(pendingJump)}
        >
          <p>
            将跳转 {Math.round((pendingJump / HOUR) * 10) / 10} 小时。AI
            需要补齐这段时间的全部生活事件、线上消息和线下场景，可能耗时很长并消耗较多额度。
          </p>
          <p>建议先跳到 1 天以内，分几次补全，阅读和生成都会更顺。</p>
        </Confirm>
      )}
    </>
  );
}
