import { useState } from 'react';
import { novelGoalFacts } from '../ai/novel-context';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import type { World } from '../core/types';
import { NovelSchema, storyStageNames } from '../core/novel-types';
import { defaultMajorSettings } from '../core/major-events';
import { getPrompts, composePrompt } from '../ai/prompts';
import { liveProvider, budgetedCompletion } from '../ai/orchestrator';
import { parseStructuredJSON } from '../ai/structured';
import { z } from 'zod';
import { Button, Field, Textarea, Input, Toggle, Status } from './ui';
export function StoryProgress({ worldId }: { worldId: string }) {
  const world = useLiveQuery(() => db.worlds.get(worldId), [worldId]);
  const n = world?.novel;
  if (!n) return null;
  return (
    <section className="panel story-progress">
      <h3>故事进展 · {storyStageNames[n.stage]}</h3>
      <p>{n.goal}</p>
      {!!world?.novelHistory?.length && (
        <details>
          <summary>此前的故事目标与结局（{world.novelHistory.length}）</summary>
          {world.novelHistory.map((old, i) => (
            <article key={i}>
              <h4>{old.goal}</h4>
              <p>{old.ending?.text ?? `${old.milestones.length} 个历史剧情节点`}</p>
            </article>
          ))}
        </details>
      )}
      <small>{n.enabled ? '叙事推进已开启' : '叙事推进已停止，历史保留'}</small>
      {n.unresolved.map((s, i) => (
        <p key={i}>未解：{s}</p>
      ))}
      <details>
        <summary>目标条件与事件依据 · {n.milestones.length} 个剧情节点</summary>
        {n.conditions.map((c) => (
          <p key={c.id}>
            {c.description} · {new Set(c.evidence.map((e) => e.eventId)).size} 项事件依据
            {c.evidence.map((e, i) => (
              <small key={i}>
                {' '}
                [{e.eventId}] {e.quote}
              </small>
            ))}
          </p>
        ))}
        {n.milestones.map((m) => (
          <p key={m.eventId}>
            [{m.eventId}] {m.summary}
          </p>
        ))}
      </details>
      {n.ending && (
        <>
          <h4>结尾回顾</h4>
          <p>{n.ending.text}</p>
          <Button
            onClick={async () => {
              const { saveManagedWorld } = await import('../core/novel');
              await saveManagedWorld({ ...world, novel: { ...n, enabled: false } });
            }}
          >
            结束小说模式，保留世界并继续开放观察
          </Button>
        </>
      )}
    </section>
  );
}
export function NovelSettings({ world, onChange }: { world: World; onChange: (w: World) => void }) {
  const n = world.novel ?? NovelSchema.parse({ enabled: false, goal: '' });
  const [constraints, setConstraints] = useState(''),
    [candidates, setCandidates] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <section className="settings-section">
      <h3>小说模式</h3>
      <Toggle
        label="启用小说模式（保存时结局目标必填）"
        checked={n.enabled}
        onChange={(enabled) => onChange({ ...world, novel: { ...n, enabled } })}
      />
      <Field label="你希望这个世界最终走向怎样的结局？">
        <Textarea
          rows={4}
          value={n.goal}
          maxLength={4000}
          onChange={(e) => onChange({ ...world, novel: { ...n, goal: e.target.value } })}
        />
      </Field>
      <details>
        <summary>AI 帮我设计结局 · 生成候选后手动选择</summary>
        <Field label="结局额外要求">
          <Textarea value={constraints} onChange={(e) => setConstraints(e.target.value)} />
        </Field>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const snapshot = await getPrompts(db);
              const facts = await novelGoalFacts(db, world.id);
              const response = await budgetedCompletion(
                db,
                await liveProvider(db),
                composePrompt(
                  'novel',
                  snapshot,
                  {
                    world: { name: world.name, rules: world.rules, description: world.description },
                    input: {
                      ...facts,
                      requirements: constraints,
                    },
                  },
                  '只返回 JSON {"candidates":["结局目标1","结局目标2","结局目标3"]}，提供不同方向的3个可编辑目标，不当作已发生事实，不默认恋爱或团圆。',
                ),
                world.id,
                'novel',
                snapshot,
                undefined,
                { outputBudget: 2200 },
              );
              setCandidates(
                z
                  .object({ candidates: z.array(z.string().min(1).max(4000)).min(1).max(5) })
                  .parse(parseStructuredJSON(response.content)).candidates,
              );
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '设计候选中…' : '生成结局候选'}
        </Button>
        {candidates.map((goal, i) => (
          <article className="panel" key={i}>
            <p>{goal}</p>
            <Button onClick={() => onChange({ ...world, novel: { ...n, goal } })}>
              选择此目标并继续编辑
            </Button>
          </article>
        ))}
      </details>
      {n.enabled && (
        <>
          <Status>
            保存后强制启用人物演化与周期重大事件，核心锁定仍受保护。关闭小说模式会恢复启用前的两项配置，已发生剧情不回滚。
          </Status>
          <Field label="最长重大事件间隔（虚拟日）">
            <Input
              type="number"
              min={1}
              max={36500}
              value={world.majorEventSettings?.maximumIntervalDays ?? 7}
              onChange={(e) =>
                onChange({
                  ...world,
                  majorEventSettings: {
                    ...(world.majorEventSettings ?? defaultMajorSettings),
                    enabled: true,
                    maximumIntervalDays: Number(e.target.value),
                  },
                })
              }
            />
          </Field>
          <p>人物动态演化：已强制开启 · 重大事件：已强制开启。仍需在角色页解锁允许变化的字段。</p>
        </>
      )}
      {n.milestones.length > 0 && (
        <p>
          当前阶段：{storyStageNames[n.stage]} · {n.milestones.length} 个真实事件节点
        </p>
      )}
      {error && <Status error>{error}</Status>}
    </section>
  );
}
