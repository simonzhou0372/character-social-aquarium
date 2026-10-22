import { z } from 'zod';
import { db, type AquariumDB } from '../data/db';
import { getPrompts, composePrompt } from './prompts';
import { budgetedCompletion, liveProvider } from './orchestrator';
import { parseStructuredJSON } from './structured';
import { ProviderError, type Provider } from './provider';
import { newCharacter } from '../data/seed';
const short = z.string().min(1).max(1000);
export const CharacterDraftSchema = z.object({
  name: z.string().min(1).max(60),
  source: z.string().max(200).default('原创'),
  bio: short,
  personality: short,
  style: short,
  habits: short,
  topicIntervalMinutes: z.number().int().min(5).max(10080).optional(),
});
export const CreationDraftSchema = z.object({
  world: z
    .object({
      name: z.string().min(1).max(80),
      description: short,
      rules: short,
      locations: z.array(z.string().min(1).max(100)).min(1).max(15),
      timezone: z.string().max(80).default('Asia/Shanghai'),
      tone: short,
    })
    .optional(),
  characters: z.array(CharacterDraftSchema).max(8),
  groups: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        description: z.string().max(1000),
        memberNames: z.array(z.string().min(1).max(60)).min(2).max(30),
      }),
    )
    .max(5),
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
  const characterExample = {
    name: '角色名1',
    source: '原创',
    bio: '具体身份',
    personality: '性格',
    style: '口吻',
    habits: '生活习惯',
    topicIntervalMinutes: 120,
  };
  const example = {
    ...(kind === 'world'
      ? {
          world: {
            name: '名称',
            description: '简介',
            rules: '事实规则',
            locations: ['场景'],
            timezone: 'Asia/Shanghai',
            tone: '基调',
          },
        }
      : {}),
    characters: [characterExample, { ...characterExample, name: '角色名2' }],
    groups: [{ name: '团体名', description: '介绍', memberNames: ['角色名1', '角色名2'] }],
    uncertain: '推测与原创补充说明',
  };
  const contract = `创建${kind === 'world' ? '一套世界观、角色及团体' : '一个团体和必要的新角色'}草稿，尊重预填写资料与约束。只返回一个 JSON 对象，完整格式示例：${JSON.stringify(example)}。最多新建 6 位角色、${kind === 'world' ? 3 : 1} 个团体。团体成员只可引用输入中已有角色名或本次新建角色名。已有角色不能在 characters 重复生成，不修改已有角色设定。${kind === 'group' ? '必须恰好一个团体，不生成 world 字段。' : ''}不确定原作事实要标注，不擅自确认用户未设定的亲密关系。`;
  const prompt = composePrompt(
    task,
    snapshot,
    { input: { known, constraints, existingCharacterNames: existingNames } },
    contract,
  );
  const client = provider ?? (await liveProvider(d));
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await budgetedCompletion(
      d,
      client,
      attempt
        ? [
            ...prompt,
            {
              role: 'user',
              content:
                '上次草稿结构不完整。重新返回符合完整格式示例的单个 JSON 对象，保留原始约束，不要说明或代码围栏。',
            },
          ]
        : prompt,
      'global',
      task,
      snapshot,
      undefined,
      { tightContext: attempt === 1, outputBudget: kind === 'world' ? 5000 : 3500 },
    );
    try {
      if (response.finishReason === 'length')
        throw new ProviderError('truncated', '草稿输出被截断');
      return validateDraft(parseStructuredJSON(response.content), kind, existingNames);
    } catch (error) {
      if (attempt === 1)
        throw new ProviderError(
          'schema',
          '草稿格式仍不完整，已停止自动重试。请减少一次生成的人数或细节；预填写内容仍保留。',
        );
    }
  }
  throw new ProviderError('schema', '草稿生成未完成');
}
