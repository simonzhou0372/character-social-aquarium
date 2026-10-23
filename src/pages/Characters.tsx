import { RecycleButton } from '../components/RecycleButton';
import { EvolutionPanel } from '../components/EvolutionPanel';
import { useObservation } from '../components/ObservationManager';
import { AvatarUpload } from '../components/AvatarUpload';
import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Search, Sparkles, Save, MessageCircle, Sliders } from 'lucide-react';
import { db } from '../data/db';
import { newCharacter } from '../data/seed';
import { CharacterSchema, type Character } from '../core/types';
import { topicPolicy } from '../core/simulation';
import { generateProfile } from '../ai/orchestrator';
import { Avatar, Button, Field, Input, Textarea, Select, Modal, Status } from '../components/ui';
export function CharacterEditor({
  character,
  worldId,
  onClose,
}: {
  character?: Character;
  worldId: string;
  onClose: () => void;
}) {
  const [c, setC] = useState<Character>(character ?? newCharacter()),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [suggestion, setSuggestion] = useState<Awaited<ReturnType<typeof generateProfile>>>();
  const worlds = useLiveQuery(() => db.worlds.filter((entity) => !entity.deletedAt).toArray(), []);
  const memberships = useLiveQuery(
    () => db.memberships.where('characterId').equals(c.id).toArray(),
    [c.id],
  );
  const [selected, setSelected] = useState<string[] | null>(null);
  const [override, setOverride] = useState('');
  const [styleOverride, setStyleOverride] = useState('');
  useEffect(() => {
    const m = memberships?.find((m) => m.worldId === worldId);
    if (m) {
      setOverride(m.bioOverride);
      setStyleOverride(m.styleOverride);
    }
  }, [memberships, worldId]);
  const patch = (v: Partial<Character>) => setC((s) => ({ ...s, ...v }));
  const activeWorlds =
    selected ?? (character ? (memberships?.map((m) => m.worldId) ?? []) : [worldId]);
  async function save() {
    try {
      const parsed = CharacterSchema.parse(c);
      if (!activeWorlds.length) throw new Error('请选择至少一个世界');
      await db.transaction('rw', db.characters, db.memberships, async () => {
        await db.characters.put(parsed);
        const existing = await db.memberships.where('characterId').equals(c.id).toArray();
        for (const w of activeWorlds) {
          const old = existing.find((m) => m.worldId === w);
          await db.memberships.put({
            ...old,
            id: old?.id ?? `${w}:${c.id}`,
            worldId: w,
            characterId: c.id,
            identity: old?.identity ?? '',
            bioOverride: w === worldId ? override : (old?.bioOverride ?? ''),
            styleOverride: w === worldId ? styleOverride : (old?.styleOverride ?? ''),
          });
        } /* Membership removal is intentionally unavailable while referenced by histories. */
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '请检查角色信息');
    }
  }
  return (
    <Modal title={character ? '编辑角色资料' : '认识一位新角色'} onClose={onClose} wide>
      <div className="character-editor">
        <div className="editor-avatar">
          <AvatarUpload value={c.avatar} name={c.name} onChange={(avatar) => patch({ avatar })} />
        </div>
        <div className="editor-main">
          <div className="form-grid">
            <Field label="角色名称">
              <Input
                value={c.name}
                maxLength={60}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </Field>
            <Field label="原作 / 来源">
              <Input value={c.source} onChange={(e) => patch({ source: e.target.value })} />
            </Field>
          </div>
          <Field label="性别（自由文本，可留空）">
            <Input value={c.gender ?? ''} onChange={(e) => patch({ gender: e.target.value })} />
          </Field>
          <Field label="实体模式">
            <Select
              value={c.entityMode ?? 'interactive'}
              onChange={(e) =>
                patch({ entityMode: e.target.value as 'interactive' | 'background' })
              }
            >
              <option value="interactive">可互动角色</option>
              <option value="background">背景人物 / 传闻人物</option>
            </Select>
          </Field>
          {c.entityMode === 'background' && (
            <Field label="名气程度（不自动授予知识权限）">
              <Input
                type="range"
                min="0"
                max="100"
                value={c.fame ?? 0}
                onChange={(e) => patch({ fame: Number(e.target.value) })}
              />
            </Field>
          )}
          <Button
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                setSuggestion(await generateProfile({ name: c.name, source: c.source, known: c }));
              } catch (e) {
                setError(e instanceof Error ? e.message : '生成失败');
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
          >
            <Sparkles size={16} />
            {busy ? '正在构思…' : 'AI 帮写资料'}
          </Button>
          {(['bio', 'personality', 'style', 'habits'] as const).map((key, i) => (
            <Field key={key} label={['人设简介与身份', '性格与价值观', '说话习惯', '生活习惯'][i]}>
              <Textarea
                rows={2}
                value={c[key]}
                onChange={(e) => patch({ [key]: e.target.value })}
              />
            </Field>
          ))}
          <Field label="加入世界（一个角色可加入多个世界）">
            <div className="check-list">
              {worlds?.map((w) => (
                <label key={w.id}>
                  <input
                    type="checkbox"
                    checked={activeWorlds.includes(w.id)}
                    disabled={!!memberships?.some((m) => m.worldId === w.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...activeWorlds, w.id]
                          : activeWorlds.filter((id) => id !== w.id),
                      )
                    }
                  />
                  {w.name}
                </label>
              ))}
            </div>
          </Field>
          <EvolutionPanel worldId={worldId} characterId={c.id} />
          <details className="advanced">
            <summary>当前世界专属设定（不影响其他世界）</summary>
            <Field label="当前世界身份 / 简介覆盖">
              <Textarea
                placeholder={
                  memberships?.find((m) => m.worldId === worldId)?.bioOverride ||
                  '留空时使用全局资料'
                }
                value={override}
                onChange={(e) => setOverride(e.target.value)}
              />
            </Field>
            <Field label="当前世界口吻覆盖">
              <Textarea value={styleOverride} onChange={(e) => setStyleOverride(e.target.value)} />
            </Field>
          </details>
          <details className="advanced" open>
            <summary>
              <Sliders size={15} />
              自主行为与日程
            </summary>
            <Field label="主动发起话题的方式">
              <Select
                value={topicPolicy(c).mode}
                onChange={(e) =>
                  patch({ initiationMode: e.target.value as Character['initiationMode'] })
                }
              >
                <option value="interval">忍不住想聊：按间隔寻找机会</option>
                <option value="important">只有重要共同事件才主动</option>
                <option value="never">几乎不主动：只考虑回复</option>
              </Select>
            </Field>
            {topicPolicy(c).mode === 'interval' && (
              <Field
                label="多久没主动开口，会想找人聊（世界分钟）"
                hint="达到间隔后，在醒着、能看手机且有合适对象时寻找机会，不是固定闹钟。回复不重置主动话题间隔。"
              >
                <Input
                  aria-label="主动话题间隔"
                  type="number"
                  min={5}
                  max={10080}
                  value={topicPolicy(c).minutes}
                  onChange={(e) =>
                    patch({
                      topicIntervalMinutes: Number(e.target.value),
                      initiationMode: 'interval',
                    })
                  }
                />
                <small>
                  {topicPolicy(c).minutes < 60
                    ? `约每 ${topicPolicy(c).minutes} 分钟`
                    : `约每 ${(topicPolicy(c).minutes / 60).toFixed(1)} 小时`}
                  开始想主动聊天
                </small>
              </Field>
            )}
            {(
              [
                ['initiative', '达到间隔后的主动强度'],
                ['replyChance', '回复倾向'],
                ['phoneHabit', '看手机的频率'],
              ] as const
            ).map(([k, label]) => (
              <Field key={k} label={`${label} · ${Math.round(c[k] * 100)}%`}>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={c[k]}
                  onChange={(e) => patch({ [k]: Number(e.target.value) })}
                />
              </Field>
            ))}
            <div className="form-grid">
              {(
                [
                  ['wake', '起床时间'],
                  ['sleep', '睡觉时间'],
                  ['busyStart', '工作/学习开始'],
                  ['busyEnd', '工作/学习结束'],
                ] as const
              ).map(([k, label]) => (
                <Field label={label} key={k}>
                  <Select value={c[k]} onChange={(e) => patch({ [k]: Number(e.target.value) })}>
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>
                        {i}:00
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
            <Field label="单次回复条数（仍受全局上限约束）">
              <Select
                value={c.messagePreferences?.maxMessages ?? 3}
                onChange={(e) =>
                  patch({
                    messagePreferences: {
                      maxMessages: Number(e.target.value),
                      suggestedMax: c.messagePreferences?.suggestedMax ?? 60,
                    },
                  })
                }
              >
                {[1, 2, 3].map((n) => (
                  <option value={n} key={n}>
                    {n} 条
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="此角色的建议最长字数">
              <Input
                type="number"
                min={1}
                max={500}
                value={c.messagePreferences?.suggestedMax ?? 60}
                onChange={(e) =>
                  patch({
                    messagePreferences: {
                      maxMessages: c.messagePreferences?.maxMessages ?? 3,
                      suggestedMax: Number(e.target.value),
                    },
                  })
                }
              />
            </Field>
            <Field label="代表色">
              <Input
                type="color"
                value={c.color}
                onChange={(e) => patch({ color: e.target.value })}
              />
            </Field>
          </details>
          {error && <Status error>{error}</Status>}
          <div className="modal-actions">
            {character && (
              <RecycleButton
                kind="characters"
                id={character.id}
                name={character.name}
                onDone={onClose}
              />
            )}
            <Button onClick={onClose}>取消</Button>
            <Button variant="primary" onClick={save}>
              <Save size={16} />
              保存角色
            </Button>
          </div>
        </div>
      </div>
      {suggestion && (
        <Modal title="AI 建议 · 请核对后选择接受" onClose={() => setSuggestion(undefined)}>
          <Status>{suggestion.uncertain}</Status>
          {suggestion.gender && (
            <div>
              <h4>性别建议</h4>
              <p>{suggestion.gender}</p>
              <Button onClick={() => patch({ gender: suggestion.gender })}>采用性别建议</Button>
            </div>
          )}
          {(['bio', 'personality', 'style', 'habits'] as const).map((key, i) => (
            <div className="suggestion-field" key={key}>
              <h4>{['简介', '性格', '口吻', '生活习惯'][i]}</h4>
              <Textarea
                value={suggestion[key]}
                onChange={(e) => setSuggestion({ ...suggestion, [key]: e.target.value })}
              />
              <Button onClick={() => patch({ [key]: suggestion[key] })}>采用这一项</Button>
            </div>
          ))}
          <Button variant="primary" onClick={() => setSuggestion(undefined)}>
            完成核对
          </Button>
        </Modal>
      )}
    </Modal>
  );
}
export function Characters({ worldId, onChat }: { worldId: string; onChat: (id: string) => void }) {
  const observation = useObservation(worldId);
  const all = useLiveQuery(() => db.characters.filter((entity) => !entity.deletedAt).toArray(), []),
    states = useLiveQuery(() => db.states.where('worldId').equals(worldId).toArray(), [worldId]),
    memberships = useLiveQuery(
      () => db.memberships.where('worldId').equals(worldId).toArray(),
      [worldId],
    );
  const [search, setSearch] = useState(''),
    [edit, setEdit] = useState<Character | null | undefined>();
  const chars = all?.filter(
    (c) => memberships?.some((m) => m.characterId === c.id) && c.name.includes(search),
  );
  return (
    <div>
      <div className="page-heading">
        <div>
          <span className="eyebrow">PEOPLE / 角色图鉴</span>
          <h1>
            每个人，都有自己的故事<span>↗</span>
          </h1>
          <p>他们有相同的世界，也有不同的生活。</p>
        </div>
        <Button variant="primary" onClick={() => setEdit(null)}>
          <Plus size={17} />
          添加角色
        </Button>
      </div>
      <div className="search-box">
        <Search size={17} />
        <input
          aria-label="搜索角色"
          placeholder="搜索名字，找到熟悉的人…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="character-grid">
        {chars?.map((c, i) => (
          <article
            className="character-card"
            key={c.id}
            style={{ '--character-color': c.color } as React.CSSProperties}
          >
            <div className="character-card-art" onClick={() => setEdit(c)}>
              <span className="card-index">NO. {String(i + 1).padStart(2, '0')}</span>
              <Avatar character={c} size={180} />
              <span className="character-source">{c.source}</span>
            </div>
            <div className="character-card-body">
              <div className="section-title">
                <h3>{c.name}</h3>
                <span className="tiny-status">
                  {c.entityMode === 'background'
                    ? '仅作为世界背景'
                    : (states?.find((s) => s.characterId === c.id)?.activity ?? '尚未开始生活')}
                </span>
              </div>
              <p>
                {c.gender || '性别未设定'} ·{' '}
                {c.entityMode === 'background'
                  ? '背景人物'
                  : observation?.jobs.some((j) => j.characterIds.includes(c.id))
                    ? '历史补全中'
                    : observation?.activeIds.has(c.id)
                      ? '正在观察'
                      : '静默'}
              </p>
              <p>{c.bio || '故事等待你来写下。'}</p>
              <div className="tags">
                {c.tags.map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
              <div className="toolbar">
                <Button onClick={() => setEdit(c)}>查看 / 编辑</Button>
                <Button variant="ghost" aria-label={`与${c.name}聊天`} onClick={() => onChat(c.id)}>
                  <MessageCircle size={17} />
                </Button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {edit !== undefined && (
        <CharacterEditor
          character={edit ?? undefined}
          worldId={worldId}
          onClose={() => setEdit(undefined)}
        />
      )}
    </div>
  );
}
