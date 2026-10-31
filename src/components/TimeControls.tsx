import { WorldDateEditor } from './WorldDateEditor';
import { calendarTick, realLocalDate, type WorldDateTime } from '../core/calendar';
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Clock3, Rewind } from 'lucide-react';
import { db } from '../data/db';
import { configureTime, rewindWorld, startCalendarBranch, timeSpeeds } from '../core/time';
import { setRunning } from '../core/engine';
import { Button, Field, Select, Confirm, Status } from './ui';
import { TimeJumpControls } from './TimeJumpControls';
export function TimeControls({ worldId, compact = false }: { worldId: string; compact?: boolean }) {
  const data = useLiveQuery(
    async () => ({
      cp: await db.checkpoints.get(worldId),
      world: await db.worlds.get(worldId),
    }),
    [worldId],
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [date, setDate] = useState<WorldDateTime>(realLocalDate(Date.now(), 'Asia/Shanghai')),
    [confirm, setConfirm] = useState(false),
    [newStory, setNewStory] = useState(false);
  const cp = data?.cp,
    mode = cp?.timeMode ?? 'god';
  async function change(nextMode: 'god' | 'real', speed: number) {
    if (!cp) return;
    setBusy(true);
    setError('');
    try {
      await configureTime(worldId, nextMode, speed);
    } catch (e) {
      setError(e instanceof Error ? e.message : '时间设置失败');
    } finally {
      setBusy(false);
    }
  }
  const body = (
    <>
      <div className="time-mode-options">
        {(['god', 'real'] as const).map((v) => (
          <button
            disabled={busy}
            key={v}
            className={mode === v ? 'selected' : ''}
            onClick={() =>
              void change(v, v === 'real' ? 1 : cp?.speed === 1 ? 30 : (cp?.speed ?? 30))
            }
          >
            <strong>{v === 'god' ? '上帝模式' : '真实世界模式'}</strong>
            <span>{v === 'god' ? '前台可加速，可回到过去' : '始终 1×，不能操控时间'}</span>
          </button>
        ))}
      </div>
      {mode === 'god' ? (
        <>
          <Field label="前台时间加速倍率">
            <Select
              disabled={busy}
              value={cp?.speed ?? 30}
              onChange={(e) => void change('god', Number(e.target.value))}
            >
              {timeSpeeds.map((speed) => (
                <option key={speed} value={speed}>
                  {speed}×
                  {speed === 3600
                    ? ' · 现实 1 秒 = 世界 1 小时'
                    : speed === 1440
                      ? ' · 现实 1 分钟 = 世界 1 天'
                      : ''}
                </option>
              ))}
            </Select>
          </Field>
          <p className="muted">
            加速只作用于页面可见时。关闭、休眠或切到后台后，离线补全始终按真实时间 1×
            前进。高倍率会更快使用当天的 AI 预算。
          </p>
          <TimeJumpControls worldId={worldId} />
          <div className="rewind-controls">
            <Field label="回到某一天（世界当地日期）">
              <WorldDateEditor value={date} onChange={setDate} />
            </Field>
            <Button disabled={busy} onClick={() => setConfirm(true)}>
              <Rewind size={15} />
              回到这一天
            </Button>
            <Button onClick={() => setNewStory(true)}>从指定日期开启新故事</Button>
          </div>
        </>
      ) : (
        <Status>
          真实时间下，消息可能要等几十分钟甚至数小时。角色会睡觉、忙碌、已读不回，很多时候需要等待。暂停会冻结世界，关闭浏览器也保持暂停；想更快观察可切回上帝模式。
        </Status>
      )}
      {error && <Status error>{error}</Status>}
      {newStory && (
        <Confirm
          title="从新日期建立独立世界？"
          confirmLabel="建立日期分支"
          onClose={() => setNewStory(false)}
          onConfirm={async () => {
            try {
              if (!cp) return;
              await setRunning(worldId, false, cp.mode);
              await startCalendarBranch(worldId, date);
              setNewStory(false);
            } catch (e) {
              setError(String(e));
              setNewStory(false);
            }
          }}
        >
          <p>
            保留原世界与全部历史，以相同人物、团体、关系和知识建立暂停的新世界。新故事从所选日期开始，不搬移旧事件，也不会补全两个故事日期之间的年月。
          </p>
        </Confirm>
      )}
      {confirm && (
        <Confirm
          title="回到过去，保留原时间线？"
          confirmLabel="回到这一天"
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            if (!data?.world || !cp) return;
            setBusy(true);
            setError('');
            try {
              const at = calendarTick(data.world, date);
              if (at >= cp.simTime) throw new Error('请选择早于当前世界时间的日期');
              await setRunning(worldId, false, cp.mode);
              await rewindWorld(worldId, at);
              setConfirm(false);
            } catch (e) {
              setError(e instanceof Error ? e.message : '回退失败');
              setConfirm(false);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>
            会创建从 {date.year}/{date.month}/{date.day} {date.hour}:{date.minute}{' '}
            继续生活的新时间线，切换到该世界并暂停，原世界和聊天完整保留。
          </p>
          <p>
            采用当前角色与世界设定，复制目标时间之前的记录；目标之后的消息与记忆不会带入新时间线。
          </p>
        </Confirm>
      )}
    </>
  );
  if (compact)
    return (
      <details className="panel time-controls">
        <summary>
          <Clock3 size={17} />
          时间控制 · {mode === 'real' ? '真实世界 1×' : `上帝模式 ${cp?.speed ?? 30}×`}
        </summary>
        {body}
      </details>
    );
  return (
    <section className="panel time-controls">
      <h2>世界的时间，由你选择。</h2>
      {body}
    </section>
  );
}
