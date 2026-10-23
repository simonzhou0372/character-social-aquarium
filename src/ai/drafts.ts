import { z } from 'zod';
import { db, type AquariumDB } from '../data/db';
import { getPrompts, composePrompt } from './prompts';
import { budgetedCompletion, liveProvider } from './orchestrator';
import { parseStructuredJSON, completedField } from './structured';
import { ProviderError, type Provider } from './provider';
import { newCharacter } from '../data/seed';
const short = z.string().min(1).max(1000);
export const CharacterDraftSchema = z.object({
  name: z.string().min(1).max(60),
  source: z.string().max(200).default('原创'),
  bio: z.string().max(1000).default(''),
  personality: z.string().max(1000).default(''),
  style: z.string().max(1000).default(''),
  habits: z.string().max(1000).default(''),
  topicIntervalMinutes: z.number().int().min(5).max(10080).optional(),
});
export const CreationDraftSchema = z.object({
  world: z
    .object({
      name: z.string().min(1).max(80),
      description: z.string().max(1000).default(''),
      rules: z.string().max(1000).default('遵循已确认世界设定，未指定部分待用户确认'),
      locations: z.array(z.string().min(1).max(100)).min(1).max(15).default(['日常活动地点']),
      timezone: z.string().max(80).default('Asia/Shanghai'),
      tone: z.string().max(1000).default('日常'),
    })
    .optional(),
  characters: z.array(CharacterDraftSchema).max(8).default([]),
  groups: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        description: z.string().max(1000).default(''),
        memberNames: z.array(z.string().min(1).max(60)).min(2).max(30),
      }),
    )
    .max(5)
    .default([]),
  issues: z.array(z.object({ path: z.string(), reason: z.string() })).optional(),
  partial: z.boolean().optional(),
  uncertain: z.string().max(2000).default('AI 草稿，请核对作品事实与原创补充。'),
});
export type CreationDraft = z.infer<typeof CreationDraftSchema>;
export type CharacterDraft = z.infer<typeof CharacterDraftSchema>;
export function draftCharacter(draft: CharacterDraft) {
  return { ...newCharacter(draft.name), ...draft };
}
export function validateDraft(input: unknown, kind: 'world' | 'group', existingNames: string[]) {
  const draft = CreationDraftSchema.parse(input);
  if (kind === 'world' && !draft.world) throw new Error('世界观草稿缺少世界规则');
  if (kind === 'group' && draft.groups.length !== 1) throw new Error('团体草稿应恰好包含一个团体');
  const names = [...existingNames, ...draft.characters.map((c) => c.name)];
  if (new Set(names).size !== names.length)
    throw new Error('草稿角色与现有人物重名，请修改约束后重新生成');
  for (const group of draft.groups) {
    if (new Set(group.memberNames).size < 2 || group.memberNames.some((n) => !names.includes(n)))
      throw new Error('草稿团体包含不存在的角色');
  }
  if (draft.world) new Intl.DateTimeFormat('zh', { timeZone: draft.world.timezone });
  return draft;
}
export async function generateCreationDraft(
  kind: 'world' | 'group',
  known: unknown,
  constraints: string,
  existingNames: string[],
  d: AquariumDB = db,
  provider?: Provider,
) {
  const snapshot = await getPrompts(d);
  const task = kind === 'world' ? 'worldDraft' : 'groupDraft';
  const example = {
    ...(kind === 'world' ? { world: { name: '世界名称' } } : {}),
    characters: [{ name: '角色名' }],
    groups: [{ name: '团体名', memberNames: ['角色名', '已有角色名'] }],
  };
  const contract = `${kind === 'world' ? '生成一套世界观、人物与团体。' : '生成一个团体及其新增人物。'}如果输入有 previousDraft，只返回 issues 指出的失败部分，已成功角色不要重新生成。生成基本草稿，只返回 JSON ${JSON.stringify(example)}。必要字段只有世界/角色/团体名称及团体成员；source、bio、personality、style、habits、介绍、规则、场景、基调均可选，缺失会在预览中留待补充。最多8位新角色、${kind === 'group' ? 1 : 5}个团体。用户未给姓名时合理原创姓名，不因缺少细节拒绝生成。已有角色名不可重复创建。团体只能引用已有或本次新建的名字。${kind === 'group' ? '恰好一个团体。' : ''}区分原作事实、推测与原创。`;
  const prompt = composePrompt(
    task,
    snapshot,
    { input: { known, constraints, existingCharacterNames: existingNames } },
    contract,
  );
  const client = provider ?? (await liveProvider(d));
  let cause = '响应格式错误';
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await budgetedCompletion(
      d,
      client,
      attempt
        ? [
            ...prompt,
            {
              role: 'user',
              content: `仅修复失败部分：${cause}。返回最小基本草稿，不重写已成功内容。`,
            },
          ]
        : prompt,
      'global',
      task,
      snapshot,
      undefined,
      { tightContext: attempt > 0, outputBudget: attempt ? 6500 : 5000 },
    );
    try {
      let raw: any;
      try {
        raw = parseStructuredJSON(response.content);
      } catch (error) {
        raw = {
          world: completedField(response.content, 'world'),
          characters: completedField(response.content, 'characters') ?? [],
          groups: completedField(response.content, 'groups') ?? [],
        };
        if (!raw.world && !raw.characters.length && !raw.groups.length) throw error;
      }
      const issues: { path: string; reason: string }[] = [];
      const characters: CharacterDraft[] = [];
      const names = new Set(existingNames);
      if (!Array.isArray(raw.characters ?? [])) throw new Error('characters 应为数组');
      if ((raw.characters ?? []).length > 8)
        issues.push({ path: 'characters', reason: '本批最多8人，其余保留为待生成需求' });
      for (const [i, item] of (raw.characters ?? []).slice(0, 8).entries()) {
        const c = CharacterDraftSchema.safeParse(item);
        if (!c.success) {
          issues.push({
            path: `characters[${i}]`,
            reason: c.error.issues.map((x) => x.path.join('.') + ':' + x.message).join('；'),
          });
          continue;
        }
        if (names.has(c.data.name)) {
          issues.push({ path: `characters[${i}].name`, reason: '姓名重复，请手动修改' });
          continue;
        }
        names.add(c.data.name);
        characters.push(c.data);
      }
      const groups: any[] = [];
      for (const [i, g] of (Array.isArray(raw.groups) ? raw.groups : [])
        .slice(0, kind === 'group' ? 1 : 5)
        .entries()) {
        const available = [...names];
        const group = {
          description: '',
          ...g,
          memberNames: g.memberNames ?? available.slice(0, 2),
        };
        if (
          !group.name ||
          !Array.isArray(group.memberNames) ||
          new Set(group.memberNames).size < 2 ||
          group.memberNames.some((n: string) => !names.has(n))
        ) {
          issues.push({ path: `groups[${i}]`, reason: '团体名称或成员引用待补充' });
          continue;
        }
        groups.push(group);
      }
      if (kind === 'group' && !groups.length) {
        groups.push({
          name: (known as any)?.group?.name ?? '待完善团体',
          description: '成员为草稿建议，请确认',
          memberNames: [...names].slice(0, 2),
        });
      }
      const world =
        kind === 'world'
          ? { name: '待完善世界', ...(known as any)?.world, ...raw.world }
          : undefined;
      if (!characters.length && !raw.world && !groups.length)
        throw new Error('没有可验证的基本字段');
      if (response.finishReason === 'length')
        issues.push({ path: 'response', reason: '输出被截断；已保留完整对象，未闭合的字段未采纳' });
      const previous = (known as any)?.previousDraft as CreationDraft | undefined;
      const combined = previous
        ? [
            ...previous.characters,
            ...characters.filter((c) => !previous.characters.some((p) => p.name === c.name)),
          ]
        : characters;
      return CreationDraftSchema.parse({
        world: previous?.world ?? world,
        characters: combined.slice(0, 8),
        groups: groups.length ? groups : (previous?.groups ?? []),
        uncertain: raw.uncertain,
        issues,
        partial: issues.length > 0,
      });
    } catch (error) {
      cause =
        error instanceof z.ZodError
          ? '字段内容不合法：' +
            error.issues.map((x) => x.path.join('.') + ':' + x.message).join('；')
          : error instanceof Error
            ? error.message
            : '响应格式错误';
      await d.taskLogs.add({
        id: crypto.randomUUID(),
        worldId: 'global',
        task,
        promptVersion: snapshot.version,
        at: Date.now(),
        status: response.finishReason === 'length' ? 'truncated' : 'invalid',
        detail: cause.slice(0, 1000),
      });
    }
  }
  throw new ProviderError('schema', `草稿未完成：${cause}。预填写资料已保留，可重试或手动完成。`);
}
