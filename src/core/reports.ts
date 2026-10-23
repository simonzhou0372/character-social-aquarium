import { db, withWorldLock, type AquariumDB } from '../data/db';
import { dayOrdinal, fromOrdinal, worldTime, formatWorldTime } from './calendar';
import { DAY, type World } from './types';
import {
  reportTypes,
  reportNames,
  emptyReports,
  type ReportType,
  type WorldReport,
  type ReportSource,
} from './focus-types';
import { resolveObservation } from './selective-observation';
import { composePrompt, getPrompts } from '../ai/prompts';
import { budgetedCompletion } from '../ai/orchestrator';
import { parseStructuredJSON } from '../ai/structured';
import type { Provider } from '../ai/provider';
import { z } from 'zod';
export function reportPeriod(world: World, type: ReportType, at: number) {
  const date = worldTime(world, at),
    ordinal = dayOrdinal(date);
  let start = ordinal,
    end = ordinal + 1;
  if (type === 'weekly') {
    start = ordinal - (ordinal % 7);
    end = start + 7;
  }
  if (['monthly', 'quarterly', 'yearly'].includes(type)) {
    const month =
      type === 'yearly'
        ? 1
        : type === 'quarterly'
          ? Math.floor((date.month - 1) / 3) * 3 + 1
          : date.month;
    const count = type === 'yearly' ? 12 : type === 'quarterly' ? 3 : 1;
    start = dayOrdinal({ year: date.year, month, day: 1 });
    const next = (date.year - 1) * 12 + month - 1 + count;
    end = dayOrdinal({ year: Math.floor(next / 12) + 1, month: (next % 12) + 1, day: 1 });
  }
  const anchor = world.calendarAnchor;
  if (!anchor) throw new Error('世界需要先迁移历法');
  const anchorOrdinal = dayOrdinal(anchor.date);
  const midnight = anchor.tick - anchor.date.hour * 3600000 - anchor.date.minute * 60000;
  return {
    start: Math.max(anchor.tick, midnight + (start - anchorOrdinal) * DAY),
    end: midnight + (end - anchorOrdinal) * DAY,
  };
}
export async function archiveReports(worldId: string, d: AquariumDB = db) {
  const world = await d.worlds.get(worldId),
    cp = await d.checkpoints.get(worldId);
  if (!world || world.deletedAt || !cp || cp.paused) return;
  await d.transaction('rw', d.worldReports, d.reportCursors, d.checkpoints, async () => {
    const latest = await d.checkpoints.get(worldId);
    if (!latest || latest.paused || latest.controlVersion !== cp.controlVersion) return;
    for (const type of reportTypes) {
      if (!world.reportSettings?.[type]) continue;
      const id = worldId + ':' + type,
        cursor = await d.reportCursors.get(id);
      let at = cursor?.nextStart ?? world.calendarAnchor?.tick ?? cp.simTime;
      for (let i = 0; i < 200; i++) {
        const period = reportPeriod(world, type, at);
        if (period.end > cp.simTime || period.end <= at) break;
        const reportId = `report:${worldId}:${type}:${period.start}`;
        if (!(await d.worldReports.get(reportId)))
          await d.worldReports.put({
            id: reportId,
            worldId,
            type,
            start: period.start,
            end: period.end,
            status: 'pending',
            sources: [],
            sections: [],
            overview: '待整理：仅汇总这个周期已保存的事实。',
          });
        at = period.end;
      }
      await d.reportCursors.put({ id, worldId, type, nextStart: at });
    }
  });
}
export async function configureReports(
  worldId: string,
  settings: World['reportSettings'],
  d: AquariumDB = db,
) {
  await d.transaction('rw', d.worlds, d.checkpoints, d.reportCursors, async () => {
    const world = await d.worlds.get(worldId),
      cp = await d.checkpoints.get(worldId);
    if (!world || !cp) throw new Error('世界不存在');
    for (const type of reportTypes)
      if (
        settings?.[type] &&
        !world.reportSettings?.[type] &&
        !(await d.reportCursors.get(worldId + ':' + type))
      )
        await d.reportCursors.put({
          id: worldId + ':' + type,
          worldId,
          type,
          nextStart: reportPeriod(world, type, cp.simTime).start,
        });
    await d.worlds.update(worldId, { reportSettings: settings ?? emptyReports });
  });
}
const periodHeadings: Record<ReportType, string[]> = {
  daily: ['今日值得关注', '今天的共同活动', '聊天片段', '现实互动', '今日状态与变化', '留下的话题'],
  weekly: [
    '本周重要事件',
    '人际互动与团体活动',
    '本周线上话题',
    '值得回看的线下活动',
    '人物变化趋势',
    '尚未解决的约定',
  ],
  monthly: [
    '本月主要故事线',
    '关系与团体动态',
    '代表性交流',
    '共同生活',
    '习惯与长期倾向',
    '下月的线索',
  ],
  quarterly: [
    '本季度的重要转折',
    '人物与团体阶段变化',
    '持续的联系',
    '生活阶段的片段',
    '长期成长',
    '延续至下季度',
  ],
  yearly: [
    '年度重要经历',
    '值得珍藏的共同活动',
    '这一年的代表聊天',
    '共同生活回顾',
    '人物成长与演化',
    '未完待续',
  ],
};
const headings = [
  '重要事件',
  '共同活动',
  '线上交流',
  '线下互动',
  '人物成长',
  '值得延续的线索',
] as const;
export async function generateReport(id: string, d: AquariumDB = db, provider?: Provider) {
  return withWorldLock('report:' + id, async () => {
    const report = await d.worldReports.get(id);
    if (!report) throw new Error('报告不存在');
    if ((await d.worlds.get(report.worldId))?.deletedAt) throw new Error('世界已移入回收站');
    const cp = await d.checkpoints.get(report.worldId);
    if (!cp || cp.paused) throw new Error('世界已暂停，恢复运行后可生成新报告；已有报告可正常查看');
    const world = (await d.worlds.get(report.worldId))!,
      scope = await resolveObservation(report.worldId, d);
    await d.worldReports.update(id, { status: 'generating', error: undefined });
    try {
      const events: import('./types').ActivityEvent[] = [];
      // Range-limited streaming selection; never load all world history for a report.
      await d.events
        .where('[worldId+start]')
        .between([report.worldId, report.start], [report.worldId, report.end], true, false)
        .and(
          (e) =>
            e.status !== 'cancelled' &&
            scope.allowsEvent(e) &&
            (e.participants.length > 1 || e.type === 'major' || (e.importance ?? 0) >= 0.7),
        )
        .each((e) => {
          events.push(e);
          events.sort((a, b) => (b.importance ?? 0.4) - (a.importance ?? 0.4));
          if (events.length > 40) events.pop();
        });
      const sources: ReportSource[] = events.map((e) => ({
        id: e.id,
        type: 'event',
        label: e.description,
        at: e.start,
        characterIds: e.participants,
      }));
      const convs = (
          await d.conversations.where('worldId').equals(report.worldId).toArray()
        ).filter(scope.allowsConversation),
        conversations = new Set(convs.map((c) => c.id));
      await d.messages
        .where('simAt')
        .between(report.start, report.end, true, false)
        .and((m) => conversations.has(m.conversationId))
        .limit(12)
        .each((m) =>
          sources.push({
            id: m.id,
            type: 'message',
            label: m.text,
            at: m.simAt,
            characterIds: [m.senderId],
            conversationId: m.conversationId,
          }),
        );
      const scenes = await d.scenes
        .where('[worldId+start]')
        .between([report.worldId, report.start], [report.worldId, report.end], true, false)
        .and(scope.allowsEvent)
        .limit(12)
        .toArray();
      sources.push(
        ...scenes.map((s) => ({
          id: s.id,
          type: 'scene' as const,
          label: s.title + ' · ' + s.phases.length + '个阶段',
          at: s.start,
          characterIds: s.participants,
        })),
      );
      const evolution = await d.evolutionRecords
        .where('[worldId+at]')
        .between([report.worldId, report.start], [report.worldId, report.end], true, false)
        .and((r) => r.status === 'applied' && scope.activeIds.has(r.characterId))
        .limit(12)
        .toArray();
      sources.push(
        ...evolution.map((r) => ({
          id: r.id,
          type: 'evolution' as const,
          label: `${r.field}：${r.previousValue} → ${r.newValue}；${r.reason}`,
          at: r.at,
          characterIds: [r.characterId],
        })),
      );
      // Longer periods reuse child archives, but still retain important original facts above.
      const childType: Partial<Record<ReportType, ReportType>> = {
        weekly: 'daily',
        monthly: 'weekly',
        quarterly: 'monthly',
        yearly: 'quarterly',
      };
      if (childType[report.type]) {
        const children = await d.worldReports
          .where('[worldId+type+start]')
          .between(
            [report.worldId, childType[report.type]!, report.start],
            [report.worldId, childType[report.type]!, report.end],
            true,
            false,
          )
          .and((r) => r.status === 'ready')
          .limit(32)
          .toArray();
        for (const child of children)
          for (const source of child.sources)
            if (
              sources.length < 100 &&
              !sources.some((s) => s.id === source.id) &&
              source.at >= report.start &&
              source.at < report.end &&
              scope.allowsEvent({ participants: source.characterIds })
            )
              sources.push(source);
      }
      let sections: WorldReport['sections'] = headings
        .map((heading, i) => ({
          heading: periodHeadings[report.type][i],
          sourceIds: sources
            .filter((s) =>
              i === 0
                ? s.type === 'event' && events.some((e) => e.id === s.id && e.type === 'major')
                : i === 1
                  ? s.type === 'event' && !events.some((e) => e.id === s.id && e.type === 'major')
                  : i === 2
                    ? s.type === 'message'
                    : i === 3
                      ? s.type === 'scene'
                      : i === 4
                        ? s.type === 'evolution'
                        : false,
            )
            .map((s) => s.id),
        }))
        .filter((s) => s.sourceIds.length);
      const snap = await getPrompts(d);
      if (provider && sources.length) {
        const result = await budgetedCompletion(
          d,
          provider,
          composePrompt(
            'report',
            snap,
            {
              world: { name: world.name, era: world.era },
              input: {
                type: reportNames[report.type],
                range: [
                  formatWorldTime(world, report.start),
                  formatWorldTime(world, report.end - 1),
                ],
                sources,
                scale:
                  report.type === 'daily'
                    ? '当日重点'
                    : report.type === 'yearly'
                      ? '年度经历、成长及长期线索'
                      : '互动趋势与阶段性进展',
              },
            },
            `仅返回JSON {"sections":[{"heading":"${headings.join(' / ')}之一","sourceIds":["给出的事实ID"]}]}。只选择、去重和组织已有事实，不补写新对白或事实，不返回自创叙事。每个ID必须来自sources。`,
          ),
          report.worldId,
          'report',
          snap,
          undefined,
          { outputBudget: 2000 },
        );
        const parsed = z
          .object({
            sections: z
              .array(
                z.object({ heading: z.enum(headings), sourceIds: z.array(z.string()).max(100) }),
              )
              .max(12),
          })
          .parse(parseStructuredJSON(result.content));
        if (
          parsed.sections.some((s) =>
            s.sourceIds.some((id) => !sources.some((source) => source.id === id)),
          )
        )
          throw new Error('报告引用了不存在的事实，未保存模型内容');
        const included = new Set<string>();
        sections = parsed.sections
          .map((s) => ({
            ...s,
            sourceIds: s.sourceIds.filter((id) => {
              if (included.has(id)) return false;
              included.add(id);
              return true;
            }),
          }))
          .filter((s) => s.sourceIds.length);
        const important = events
          .filter((e) => (e.importance ?? 0) >= 0.9 && !included.has(e.id))
          .map((e) => e.id);
        if (important.length)
          sections.push({ heading: periodHeadings[report.type][0], sourceIds: important });
      }
      const current = await d.checkpoints.get(report.worldId);
      if (current?.paused || current?.controlVersion !== cp.controlVersion)
        throw new Error('世界控制状态已改变，报告等待重试');
      const overview = sources.length
        ? `${reportNames[report.type]} · ${events.length}项精选事件、${scenes.length}段线下互动、${evolution.length}条人物变化。长周期结合下级报告保留关键原始事实。`
        : '这段时间没有已保存的值得关注的新事件。世界保持平静，没有为报告额外制造故事。';
      await d.worldReports.update(id, {
        status: 'ready',
        sources,
        sections,
        overview,
        generatedAt: Date.now(),
        promptVersion: snap.version,
        error: undefined,
      });
    } catch (e) {
      await d.worldReports.update(id, {
        status: 'failed',
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  });
}
export async function processReports(worldId: string, d: AquariumDB = db) {
  await archiveReports(worldId, d);
  // Archives are cheap placeholders. Only the latest outstanding report is auto-prepared locally.
  const pending = (
    await d.worldReports
      .where('worldId')
      .equals(worldId)
      .and((r) => r.status === 'pending')
      .sortBy('end')
  ).at(-1);
  if (pending) await generateReport(pending.id, d);
}
