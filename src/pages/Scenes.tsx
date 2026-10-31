import { MultiSelect } from '../components/MultiSelect';
import { renameScene } from '../data/titles';
import { Input } from '../components/ui';
import { getPrompts } from '../ai/prompts';
import { generateScene } from '../ai/scenes';
import { liveProvider } from '../ai/orchestrator';
import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, withWorldLock } from '../data/db';
import { startWorldTask } from '../core/tasks';
import { filterScenes } from '../core/observation';
import {
  formatWorldTime,
  formatWorldClock,
  calendarTick,
  realLocalDate,
  worldTime,
  WorldDateTimeSchema,
} from '../core/calendar';
import { Avatar, Button, Field, Select, Modal, Empty, Status } from '../components/ui';
import { BookOpen, ChevronLeft, ChevronRight, Clapperboard, Pause, Play } from 'lucide-react';
import { WorldDateEditor } from '../components/WorldDateEditor';
import type { InPersonScene } from '../core/types';
export function SceneDetail({ scene, onClose }: { scene: InPersonScene; onClose: () => void }) {
  const data = useLiveQuery(
    async () => ({
      world: await db.worlds.get(scene.worldId),
      chars: await db.characters.where('id').anyOf(scene.participants).toArray(),
      event: await db.events.get(scene.eventId),
      stored: await db.scenes.get(scene.id),
      job: await db.contentJobs
        .where('worldId')
        .equals(scene.worldId)
        .and((j) => j.kind === 'scene' && j.event.id === scene.eventId)
        .first(),
    }),
    [scene.id],
  );
  scene = data?.stored ?? scene;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [readingMode, setReadingMode] = useState<'archive' | 'stage'>('stage'),
    [stageIndex, setStageIndex] = useState(0),
    [playing, setPlaying] = useState(false),
    [playSpeed, setPlaySpeed] = useState(1800);
  const fmt = (at: number) => (data?.world ? formatWorldTime(data.world, at) : '');
  const clock = (at: number) => (data?.world ? formatWorldClock(data.world, at) : '');
  const stageLines = scene.phases.flatMap((phase) =>
    phase.entries.map((entry) => ({
      ...entry,
      phaseId: phase.id,
      phaseTitle: phase.title,
      phaseParticipants: phase.participants,
    })),
  );
  const progressKey = `scene-progress:${scene.id}`;
  const [resumeIndex] = useState(() => {
    try {
      return Number(localStorage.getItem(progressKey) ?? 0);
    } catch {
      return 0;
    }
  });
  useEffect(() => {
    if (stageIndex > 0) {
      try {
        localStorage.setItem(progressKey, String(stageIndex));
      } catch {}
    }
  }, [stageIndex, progressKey]);
  const stageLine = stageLines[Math.min(stageIndex, Math.max(0, stageLines.length - 1))];
  const stagePhaseIndex = scene.phases.findIndex((p) => p.id === stageLine?.phaseId);
  useEffect(() => {
    let active = true;
    void db.settings.get('app').then((s) => {
      if (active) setReadingMode(s?.sceneReadingMode ?? 'stage');
    });
    setStageIndex(0);
    setPlaying(false);
    return () => {
      active = false;
    };
  }, [scene.id]);
  useEffect(() => {
    if (readingMode !== 'stage' || !playing || !stageLines.length) return;
    if (stageIndex >= stageLines.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(
      () => setStageIndex((index) => Math.min(stageLines.length - 1, index + 1)),
      playSpeed,
    );
    return () => window.clearTimeout(timer);
  }, [readingMode, playing, stageIndex, playSpeed, stageLines.length]);
  return (
    <Modal title={scene.title} onClose={onClose} wide>
      <details>
        <summary>编辑场景标题 · {scene.titleMode === 'custom' ? '用户自定义' : '自动生成'}</summary>
        <Input
          key={scene.title}
          aria-label="场景自定义标题"
          defaultValue={scene.title}
          onBlur={(e) => {
            if (e.target.value !== scene.title)
              void renameScene(scene.id, e.target.value).catch((e) => setError(String(e)));
          }}
        />
        <Button onClick={() => void renameScene(scene.id, undefined)}>恢复自动标题</Button>
      </details>
      <p>
        {scene.location} · {fmt(scene.start)} — {fmt(scene.end)}
      </p>
      <div className="scene-reading-switch" role="tablist" aria-label="场景阅读模式">
        <button
          role="tab"
          aria-selected={readingMode === 'archive'}
          className={readingMode === 'archive' ? 'active' : ''}
          onClick={() => {
            setReadingMode('archive');
            setPlaying(false);
          }}
        >
          <BookOpen size={15} />
          档案阅读
        </button>
        <button
          role="tab"
          aria-selected={readingMode === 'stage'}
          className={readingMode === 'stage' ? 'active' : ''}
          onClick={() => setReadingMode('stage')}
        >
          <Clapperboard size={15} />
          演出阅读
        </button>
      </div>
      <div className="chat-tools">
        <Button
          onClick={() => {
            setPlaying(false);
            setReadingMode('archive');
          }}
        >
          跳过演出 / 完整记录
        </Button>
        {resumeIndex > 0 && (
          <Button
            onClick={() => {
              setStageIndex(Math.min(resumeIndex, stageLines.length - 1));
              setReadingMode('stage');
            }}
          >
            继续上次位置
          </Button>
        )}
      </div>
      <div className="toolbar">
        {data?.chars.map((c) => (
          <span key={c.id}>
            <Avatar character={c} size={28} /> {c.name}
          </span>
        ))}
      </div>
      {scene.generationStatus === 'partial' && (
        <Status>
          {scene.generationError ?? '阶段正在生成，已完成内容已保存'}
          <Button
            disabled={busy || data?.job?.status === 'running'}
            onClick={async () => {
              setBusy(true);
              try {
                if (data?.event) {
                  const event = data.event;
                  const completed = await withWorldLock('content:' + scene.worldId, async () => {
                    const task = startWorldTask('content:' + scene.worldId);
                    try {
                      return await generateScene(
                        db,
                        event,
                        data.job?.snapshot ?? (await getPrompts(db)),
                        await liveProvider(db),
                        data.job?.recovery,
                        task.signal,
                      );
                    } finally {
                      task.done();
                    }
                  });
                  if (!completed) setError('当前世界已有内容任务运行，完成后可继续此场景。');
                }
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? '继续生成中…' : '继续未完成阶段'}
          </Button>
        </Status>
      )}
      {error && <Status error>{error}</Status>}
      {readingMode === 'archive' ? (
        <>
          <nav className="toolbar scene-phase-nav">
            {scene.phases.map((p, i) => (
              <Button
                key={p.id}
                onClick={() =>
                  document
                    .getElementById(p.id)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
              >
                {i + 1}. {p.title}
              </Button>
            ))}
          </nav>
          <div className="scene-record">
            {scene.phases.map((p) => (
              <section key={p.id} id={p.id}>
                <h3>
                  {p.title}
                  <small>{fmt(p.start)}</small>
                </h3>
                <p className="muted">
                  在场：
                  {p.participants
                    .map((id) => data?.chars.find((c) => c.id === id)?.name)
                    .join('、')}
                </p>
                {p.entries.map((e, i) => {
                  const c = data?.chars.find((c) => c.id === e.speakerId);
                  return e.kind === 'activity' ? (
                    <aside className="scene-action" key={i}>
                      <time>{clock(e.at)}</time>
                      <p>{e.text}</p>
                    </aside>
                  ) : (
                    <div
                      className="scene-dialogue"
                      key={i}
                      style={
                        {
                          borderColor: c?.color,
                          '--speaker-color': c?.color,
                        } as React.CSSProperties
                      }
                    >
                      <Avatar character={c} size={32} />
                      <div>
                        <strong>{c?.name}</strong>
                        <time>{clock(e.at)}</time>
                        <p>{e.text}</p>
                      </div>
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
        </>
      ) : stageLine ? (
        <section
          className="scene-stage"
          style={
            {
              '--scene-tone':
                data?.chars.find((c) => c.id === stageLine.speakerId)?.color ?? '#8ee8d4',
              '--phase-index': stagePhaseIndex,
            } as React.CSSProperties
          }
          aria-label="场景演出阅读"
        >
          <header className="scene-stage-head">
            <div>
              <span className="eyebrow">SCENE IN PROGRESS</span>
              <h3>{scene.title}</h3>
              <p>
                {scene.location} · {clock(stageLine.at)} · 第 {stagePhaseIndex + 1} 幕 /{' '}
                {scene.phases.length}
              </p>
            </div>
            <div className="scene-stage-cast">
              {scene.participants.slice(0, 6).map((id) => {
                const c = data?.chars.find((c) => c.id === id);
                return (
                  <span
                    key={id}
                    className={`stage-cast-avatar ${id === stageLine.speakerId ? 'speaking' : 'listening'}`}
                    title={c?.name}
                  >
                    <Avatar character={c} size={40} />
                  </span>
                );
              })}
            </div>
          </header>
          <div className="scene-stage-progress">
            {scene.phases.map((p, i) => (
              <span
                key={p.id}
                className={i < stagePhaseIndex ? 'done' : i === stagePhaseIndex ? 'current' : ''}
              >
                <i />
                {p.title}
              </span>
            ))}
          </div>
          <div className={`stage-line ${stageLine.kind === 'activity' ? 'is-action' : ''}`}>
            {stageLine.kind === 'dialogue' ? (
              <>
                <div className="stage-speaker">
                  <Avatar
                    character={data?.chars.find((c) => c.id === stageLine.speakerId)}
                    size={68}
                  />
                  <div>
                    <small>SPEAKING / {clock(stageLine.at)}</small>
                    <strong>
                      {data?.chars.find((c) => c.id === stageLine.speakerId)?.name ?? '未知角色'}
                    </strong>
                    <span>{stageLine.phaseTitle}</span>
                  </div>
                </div>
                <blockquote>{stageLine.text}</blockquote>
              </>
            ) : (
              <>
                <span className="stage-action-mark">ACTION</span>
                <p>{stageLine.text}</p>
                <small>
                  {stageLine.phaseTitle} · {clock(stageLine.at)}
                </small>
              </>
            )}
          </div>
          <div className="scene-stage-controls">
            <Button
              aria-label="上一句"
              disabled={stageIndex === 0}
              onClick={() => setStageIndex((index) => Math.max(0, index - 1))}
            >
              <ChevronLeft size={17} />
            </Button>
            <Button
              aria-label={playing ? '暂停演出' : '自动播放'}
              variant={playing ? 'primary' : 'default'}
              onClick={() => setPlaying((value) => !value)}
            >
              {playing ? <Pause size={16} /> : <Play size={16} />}
              {playing ? '暂停' : '自动播放'}
            </Button>
            <Button
              aria-label="下一句"
              disabled={stageIndex >= stageLines.length - 1}
              onClick={() => setStageIndex((index) => Math.min(stageLines.length - 1, index + 1))}
            >
              <ChevronRight size={17} />
            </Button>
            <span className="stage-counter">
              {String(stageIndex + 1).padStart(2, '0')} /{' '}
              {String(stageLines.length).padStart(2, '0')}
            </span>
            <label>
              节奏
              <Select
                aria-label="演出播放速度"
                value={playSpeed}
                onChange={(e) => setPlaySpeed(Number(e.target.value))}
              >
                <option value={2800}>慢</option>
                <option value={1800}>标准</option>
                <option value={1100}>快</option>
              </Select>
            </label>
            <button
              className="stage-skip"
              onClick={() => {
                setReadingMode('archive');
                setPlaying(false);
              }}
            >
              查看全部文本 <ChevronRight size={14} />
            </button>
          </div>
        </section>
      ) : (
        <Empty title="场景尚未有对白" description="阶段生成完成后，这里会按顺序播放。">
          <Button onClick={() => setReadingMode('archive')}>返回档案</Button>
        </Empty>
      )}
      <details>
        <summary>关联事件与生成信息</summary>
        <p>{data?.event?.description}</p>
        <p>
          主事件 {scene.eventId} · 提示词版本 {scene.promptVersion} · 仅场景参与者拥有事件记忆
        </p>
      </details>
    </Modal>
  );
}
export function Scenes({ worldId }: { worldId: string }) {
  const data = useLiveQuery(
    async () => ({
      logs: await db.taskLogs
        .filter(
          (l) =>
            l.task === 'scene-generation' &&
            (l.status === 'failed' || l.status === 'budget-limited'),
        )
        .toArray(),
      scenes: await db.scenes.toArray(),
      worlds: await db.worlds.filter((w) => !w.deletedAt).toArray(),
      chars: await db.characters.toArray(),
      memberships: await db.memberships.toArray(),
      groups: await db.groups.toArray(),
      gm: await db.groupMembers.toArray(),
      checkpoints: await db.checkpoints.toArray(),
    }),
    [worldId],
  );
  const [world, setWorld] = useState(worldId),
    [people, setPeople] = useState<string[]>([]),
    [match, setMatch] = useState<'any' | 'all'>('all'),
    [group, setGroup] = useState(''),
    [location, setLocation] = useState(''),
    [type, setType] = useState(''),
    [range, setRange] = useState(false),
    [selected, setSelected] = useState<InPersonScene>(),
    [error, setError] = useState('');
  const [from, setFrom] = useState(realLocalDate(Date.now(), 'Asia/Shanghai')),
    [to, setTo] = useState(realLocalDate(Date.now(), 'Asia/Shanghai'));
  const w = data?.worlds.find((w) => w.id === world);
  const availableWorlds = new Set(data?.worlds.map((w) => w.id));
  const inScope = (id: string) => availableWorlds.has(id) && (!world || id === world);
  // Former participants remain searchable in their original world archives.
  const historicalParticipants = new Set(
    data?.scenes.filter((s) => inScope(s.worldId)).flatMap((s) => s.participants),
  );
  const memberIds = new Set(
    data?.memberships.filter((m) => !m.inactive && inScope(m.worldId)).map((m) => m.characterId),
  );
  const characterOptions = (data?.chars ?? []).filter(
    (c) =>
      !c.deletedAt &&
      ((c.entityMode !== 'background' && memberIds.has(c.id)) || historicalParticipants.has(c.id)),
  );
  let start: number | undefined, end: number | undefined;
  try {
    if (range && w) {
      WorldDateTimeSchema.parse(from);
      WorldDateTimeSchema.parse(to);
      start = calendarTick(w, from);
      end = calendarTick(w, to);
    }
  } catch {
    /* editable intermediate values do not crash the archive */
  }
  const scenes = filterScenes(data?.scenes ?? [], {
    worldId: world || undefined,
    participants: people,
    match,
    from: start,
    to: end,
    groupMembers: group
      ? data?.gm
          .filter((m) => m.groupId === group && (!world || m.worldId === world))
          .map((m) => m.characterId)
      : undefined,
    location,
    type,
  });
  return (
    <div>
      <div className="page-heading">
        <div>
          <span className="eyebrow">IN PERSON / 线下观察</span>
          <h1>
            共同生活的那些片刻<span>◈</span>
          </h1>
          <p>独立于网上聊天的场景档案，按最新时间排列。</p>
        </div>
      </div>
      {data?.logs
        .filter((l) => !world || l.worldId === world)
        .slice(-1)
        .map((l) => (
          <Status key={l.id} error>
            部分线下场景未生成：{l.detail ?? '受到用量限制或响应无效'}
            。已有的生活事件与聊天仍可查看。
          </Status>
        ))}
      <section className="panel">
        <div className="form-grid">
          <Field label="世界观">
            <Select
              value={world}
              onChange={(e) => {
                setWorld(e.target.value);
                setPeople([]);
                setType('');
                setLocation('');
                setGroup('');
                setRange(false);
              }}
            >
              <option value="">全部世界</option>
              {data?.worlds.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="团体">
            <Select value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">全部团体</option>
              {data?.groups
                .filter((g) => !g.deletedAt && g.worldIds.some(inScope))
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="地点">
            <Select value={location} onChange={(e) => setLocation(e.target.value)}>
              <option value="">全部地点</option>
              {[
                ...new Set(
                  data?.scenes.filter((s) => !world || s.worldId === world).map((s) => s.location),
                ),
              ].map((l) => (
                <option key={l}>{l}</option>
              ))}
            </Select>
          </Field>
          <Field label="场景类型">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">全部类型</option>
              {[...new Set(data?.scenes.filter((s) => inScope(s.worldId)).map((s) => s.type))].map(
                (t) => (
                  <option key={t}>{t}</option>
                ),
              )}
            </Select>
          </Field>
        </div>
        <Field label="参与角色（可多选）">
          <MultiSelect
            label="场景参与者"
            options={characterOptions.map((c) => ({ ...c, character: c }))}
            value={people}
            onChange={setPeople}
          />
        </Field>
        <Select
          aria-label="角色匹配方式"
          value={match}
          onChange={(e) => setMatch(e.target.value as typeof match)}
        >
          <option value="all">必须同时包含所有选中角色</option>
          <option value="any">包含任意选中角色</option>
        </Select>
        {w && (
          <Button
            onClick={() => {
              setRange(!range);
              setError('');
              if (!range) {
                const d = worldTime(
                  w,
                  data?.checkpoints.find((cp) => cp.id === w.id)?.simTime ??
                    w.calendarAnchor?.tick ??
                    Date.now(),
                );
                setFrom({ ...d, hour: 0, minute: 0 });
                setTo({ ...d, hour: 23, minute: 59 });
              }
            }}
          >
            {range ? '取消日期筛选' : '筛选时间范围'}
          </Button>
        )}
        {range && (
          <>
            <WorldDateEditor label="起始时间" value={from} onChange={setFrom} />
            <WorldDateEditor label="结束时间" value={to} onChange={setTo} />
            <Button
              onClick={() => {
                try {
                  if (!w) return;
                  const a = calendarTick(w, from),
                    b = calendarTick(w, to);
                  if (a > b) throw new Error('开始时间应早于结束时间');
                  setError('');
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              检查时间范围
            </Button>
          </>
        )}
        {error && <Status error>{error}</Status>}
      </section>
      <div className="scene-archive">
        {scenes.map((s) => (
          <button className="panel scene-card" key={s.id} onClick={() => setSelected(s)}>
            <span className="eyebrow">
              {s.location} · {s.phases.length} 个阶段
            </span>
            <h3>{s.title}</h3>
            <time>
              {data?.worlds.find((w) => w.id === s.worldId) &&
                formatWorldTime(data.worlds.find((w) => w.id === s.worldId)!, s.start)}
            </time>
            <p>
              {s.participants.map((id) => data?.chars.find((c) => c.id === id)?.name).join('、')}
            </p>
            <span>阅读完整场景 ↗</span>
          </button>
        ))}
      </div>
      {!scenes.length && (
        <Empty
          title="还没有符合条件的场景"
          description="共同活动发生后，将按独立场景预算生成并保留线下记录。"
        />
      )}
      {selected && (
        <SceneDetail key={selected.id} scene={selected} onClose={() => setSelected(undefined)} />
      )}
    </div>
  );
}
