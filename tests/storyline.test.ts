import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AquariumDB } from '../src/data/db';
import { seed } from '../src/data/seed';
import { runWorld } from '../src/core/engine';
import { drainContent } from '../src/ai/content-queue';
import {
  DAY,
  HOUR,
  type ActivityEvent,
  type Conversation,
  type InPersonScene,
} from '../src/core/types';
import type { ChatInput, Provider } from '../src/ai/provider';
import {
  buildStoryThreads,
  chooseStoryConversation,
  loadStoryThreads,
  sceneRecapMemory,
} from '../src/core/storyline';
const NOW = Date.parse('2026-10-25T00:00:00Z');

const scene = (overrides: Partial<InPersonScene> = {}): InPersonScene => ({
  id: 'scene:e1',
  worldId: 'w',
  eventId: 'e1',
  title: '雨后的咖啡店',
  location: '咖啡店',
  type: 'meal',
  participants: ['a', 'b'],
  start: 1000,
  end: 2000,
  promptVersion: 1,
  phases: [
    {
      id: 'p1',
      title: '落座',
      start: 1000,
      end: 1500,
      participants: ['a', 'b'],
      entries: [
        { kind: 'activity', at: 1010, text: '窗外的雨停了。' },
        { kind: 'dialogue', at: 1020, speakerId: 'a', text: '你来得比说好的早。' },
        { kind: 'dialogue', at: 1030, speakerId: 'b', text: '路上没堵。' },
      ],
    },
  ],
  ...overrides,
});
const msg = (id: string, eventId: string, simAt: number, senderId = 'a', text = '内容') => ({
  id,
  conversationId: 'c1',
  senderId,
  seq: Number(id.replace(/\D/g, '')) || 1,
  text,
  realAt: 0,
  simAt,
  source: 'ai' as const,
  eventId,
});

describe('storyline model', () => {
  it('groups event-tagged messages into a lead / scene / follow thread', () => {
    const threads = buildStoryThreads(
      [scene()],
      [msg('m1', 'e1', 500, 'a', '晚上七点老地方？'), msg('m2', 'e1', 2500, 'b', '刚才那家店不错')],
      { now: 3000 },
    );
    expect(threads).toHaveLength(1);
    expect(threads[0].lead.map((m) => m.text)).toEqual(['晚上七点老地方？']);
    expect(threads[0].follow.map((m) => m.text)).toEqual(['刚才那家店不错']);
    expect(threads[0].state).toBe('past');
  });
  it('supports a marked legacy fallback when old archives have no message.eventId', () => {
    const raw = { ...msg('m9', 'e1', 1200, 'b', '刚才那家店不错'), eventId: undefined };
    const threads = buildStoryThreads([scene()], [], {
      now: 3000,
      derived: new Map([['e1', [raw]]]),
    });
    expect(threads[0].derived).toBe(true);
    expect(threads[0].follow.map((m) => m.text)).toEqual(['刚才那家店不错']);
  });
  it('loads a derived thread for a legacy world without event-tagged messages', async () => {
    const d = new AquariumDB('story-legacy-' + crypto.randomUUID());
    try {
      await d.scenes.put(scene({ worldId: 'w' }));
      await d.conversations.put({
        id: 'c1',
        worldId: 'w',
        kind: 'direct',
        participants: ['a', 'b'],
        name: 'AB',
        createdAt: 0,
        lastAt: 30000,
      });
      await d.messages.bulkPut([
        { ...msg('m1', 'e2', 500, 'a', '晚上还去那家店吗？'), eventId: undefined },
        { ...msg('m2', 'e2', 25000, 'b', '刚才那句话我记着了。'), eventId: undefined },
      ]);
      const threads = await loadStoryThreads('w', d, { now: 30000, limit: 3 });
      expect(threads).toHaveLength(1);
      expect(threads[0].derived).toBe(true);
      expect(threads[0].lead.map((m) => m.text)).toEqual(['晚上还去那家店吗？']);
      expect(threads[0].follow.map((m) => m.text)).toEqual(['刚才那句话我记着了。']);
    } finally {
      await d.delete();
    }
  });
  it('writes a shared memory that contains the scene title and lead-up', () => {
    const memory = sceneRecapMemory(scene(), {
      names: new Map([
        ['a', '阿岚'],
        ['b', '小满'],
      ]),
      leadTexts: ['晚上七点老地方？'],
    });
    expect(memory.id).toBe('memory:e1');
    expect(memory.owners).toEqual(['a', 'b']);
    expect(memory.content).toContain('雨后的咖啡店');
    expect(memory.content).toContain('晚上七点老地方');
    expect(memory.content).toContain('阿岚');
    expect(memory.eventId).toBe('e1');
  });
  it('prefers a group chat that contains everyone, otherwise the closest pair', () => {
    const direct = (id: string, a: string, b: string): Conversation => ({
      id,
      worldId: 'w',
      kind: 'direct',
      participants: [a, b],
      name: id,
      createdAt: 0,
      lastAt: 0,
    });
    const group: Conversation = {
      ...direct('g', 'a', 'b'),
      kind: 'group',
      participants: ['a', 'b', 'c'],
    };
    const relationships = [
      {
        id: 'r1',
        worldId: 'w',
        from: 'a',
        to: 'b',
        label: '',
        closeness: 90,
        trust: 80,
        familiarity: 90,
        stage: '',
        nickname: '',
        attitude: '',
        history: '',
        locked: false,
        boundaries: '',
      },
      {
        id: 'r2',
        worldId: 'w',
        from: 'b',
        to: 'a',
        label: '',
        closeness: 85,
        trust: 80,
        familiarity: 90,
        stage: '',
        nickname: '',
        attitude: '',
        history: '',
        locked: false,
        boundaries: '',
      },
    ];
    const pairChoice = chooseStoryConversation(
      ['a', 'b', 'c'],
      [direct('ab', 'a', 'b')],
      relationships,
    );
    expect(pairChoice?.conversation.id).toBe('ab');
    const groupChoice = chooseStoryConversation(['a', 'b', 'c'], [group], relationships);
    expect(groupChoice?.conversation.id).toBe('g');
  });
});

async function fixture() {
  const d = new AquariumDB('story-' + crypto.randomUUID());
  await seed(d, NOW);
  await d.settings.update('app', {
    unlimitedUsage: true,
    activity: 'lively',
    sceneFrequency: 1,
    sceneDailyBudget: 10,
  });
  await d.checkpoints.update('w-harbor', {
    paused: false,
    mode: 'live',
    speed: 1,
    seed: 42,
    simTime: NOW,
    realTime: NOW,
    clockAnchor: { simTime: NOW, realTime: NOW },
  });
  return d;
}

function output(contract: string, ctx: any) {
  const n = Number(contract.match(/正好生成 (\d+) 条/)?.[1] ?? 1);
  if (contract.includes('"entries"')) {
    const p = ctx.input.phase,
      event = ctx.input.event,
      existing = ctx.input.alreadyGenerated ?? [];
    const offset = Math.max(
      (p.start - event.start) / 1000 + 1,
      existing.at(-1) ? (existing.at(-1).at - event.start) / 1000 : 0,
    );
    return {
      entries: Array.from({ length: n }, (_, i) => ({
        kind: 'dialogue',
        speakerId: p.participants[i % p.participants.length],
        offset: offset + i,
        text: '刚才线上说的那件事，我还记着。',
      })),
    };
  }
  if (contract.includes('"speakerId"'))
    return {
      speakerId: contract.match(/"speakerId":"([^"]+)"/)![1],
      messages: Array.from({ length: n }, (_, i) => '那就晚点见' + (i + 1)),
    };
  return { description: ctx.state?.description ?? '一起度过了一段时间' };
}

class StoryProvider implements Provider {
  calls: ChatInput[] = [];
  async complete(messages: ChatInput) {
    this.calls.push(structuredClone(messages));
    const p = JSON.parse(messages[1].content),
      contract = messages[0].content;
    const value = p.batchId
      ? {
          batchId: p.batchId,
          results: p.tasks.map((t: any) => ({
            taskId: t.taskId,
            result: output(t.contract ?? p.sharedContract, {
              ...p.sharedContext,
              ...t.context,
              input: { ...p.sharedContext?.input, ...t.context.input },
            }),
          })),
        }
      : output(contract, p);
    const content = JSON.stringify(value);
    return {
      content,
      inputTokens: 100,
      outputTokens: 60,
      estimated: true,
    };
  }
}

async function drainAll(d: AquariumDB, provider: Provider) {
  for (let i = 0; i < 200; i++) {
    const pending = await d.contentJobs
      .filter((j) => j.status !== 'complete' && j.status !== 'failed')
      .count();
    const failed = await d.contentJobs.filter((j) => j.status === 'failed').count();
    if (!pending && !failed) return;
    await drainContent('w-harbor', d, provider);
    const stuck = await d.contentJobs.filter((j) => j.status === 'failed').toArray();
    if (stuck.length)
      throw new Error(JSON.stringify(stuck.map((j) => ({ id: j.id, error: j.error }))));
  }
  throw new Error('content queue did not drain');
}

describe('cross-medium story chain', () => {
  let d: AquariumDB;
  beforeEach(async () => {
    d = await fixture();
  });
  afterEach(async () => {
    await d.delete();
  });

  it('creates a lead -> scene -> follow dependency chain for a sampled scene', async () => {
    await runWorld(
      'w-harbor',
      { now: NOW + 12 * HOUR, deferContent: true, dispatchContent: false, maxSegments: 200 },
      d,
    );
    const jobs = await d.contentJobs.toArray();
    const leads = jobs.filter((j) => j.storyRole === 'lead');
    expect(leads.length).toBeGreaterThan(0);
    const sceneJob = jobs.find(
      (j) => j.kind === 'scene' && leads.some((l) => l.event.id === j.event.id),
    );
    expect(sceneJob).toBeTruthy();
    const lead = jobs.find((j) => j.id === `chat:story:lead:${sceneJob!.event.id}`);
    expect(lead).toBeTruthy();
    expect(lead!.at).toBeLessThan(sceneJob!.event.start);
    expect(sceneJob!.dependsOn).toContain(lead!.id);
    const follow = jobs.find((j) => j.id === `chat:story:follow:${sceneJob!.event.id}`);
    if (follow) {
      expect(follow.at).toBeGreaterThan(sceneJob!.event.end);
      expect(follow.dependsOn).toContain(sceneJob!.id);
    }
  }, 60000);

  it('generates online lead/follow around a scene and recalls it in memory', async () => {
    await runWorld(
      'w-harbor',
      { now: NOW + 12 * HOUR, deferContent: true, dispatchContent: false, maxSegments: 200 },
      d,
    );
    // Move the clock past every follow-up so the whole chain is due for this test.
    await d.checkpoints.update('w-harbor', { simTime: NOW + 2 * DAY, paused: false });
    const provider = new StoryProvider();
    await drainAll(d, provider);
    const scenes = await d.scenes.where('worldId').equals('w-harbor').toArray();
    expect(scenes.length).toBeGreaterThan(0);
    const leadJobs = await d.contentJobs.filter((j) => j.storyRole === 'lead').toArray();
    const followJobs = await d.contentJobs.filter((j) => j.storyRole === 'follow').toArray();
    const scene = scenes.find(
      (s) =>
        leadJobs.some((l) => l.event.id === s.eventId) &&
        followJobs.some((f) => f.event.id === s.eventId),
    );
    if (!scene) throw new Error('没有找到同时具备线上约定与回味的场景');
    const leadMessages = await d.messages
      .where('eventId')
      .equals(scene.eventId)
      .and((m) => m.simAt < scene.start)
      .toArray();
    const followMessages = await d.messages
      .where('eventId')
      .equals(scene.eventId)
      .and((m) => m.simAt >= scene.end)
      .toArray();
    expect(leadMessages.length).toBeGreaterThan(0);
    expect(followMessages.length).toBeGreaterThan(0);
    expect(leadMessages.every((m) => m.storyRole === 'lead')).toBe(true);
    expect(followMessages.every((m) => m.storyRole === 'follow')).toBe(true);
    const memory = await d.memories.get(`memory:${scene.eventId}`);
    expect(memory?.content).toContain(scene.title);
    // The scene request saw the online lead-up, and the follow-up request saw the scene.
    const sceneCall = provider.calls.find((call) => {
      const payload = JSON.parse(call[1].content);
      const shared = payload.sharedContext ?? payload;
      return shared?.input?.event?.id === scene.eventId && !!shared?.input?.actors;
    });
    expect(sceneCall).toBeTruthy();
    const sceneInput = JSON.parse(sceneCall![1].content);
    const sceneContext = sceneInput.sharedContext ?? sceneInput;
    const seenChat = [
      ...(sceneContext.input?.linkedChat ?? []),
      ...(sceneContext.input?.recentChat ?? []),
    ] as { text: string }[];
    expect(
      seenChat.some((m) =>
        leadMessages.some((l) => l.text.includes(m.text) || m.text.includes(l.text)),
      ),
    ).toBe(true);
    const followCall = provider.calls.find((call) => {
      const payload = JSON.parse(call[1].content);
      const shared = payload.sharedContext ?? payload;
      return shared?.input?.story?.justHappened?.some?.((s: any) => s.title === scene.title);
    });
    expect(followCall).toBeTruthy();
  }, 90000);
});
