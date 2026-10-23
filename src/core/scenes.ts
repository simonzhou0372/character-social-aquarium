import { markdownPattern, servicePattern, thoughtPattern } from './message-format';
import { SceneSchema, type InPersonScene, type ActivityEvent } from './types';
export function sceneDialogueBudget(event: ActivityEvent) {
  const minutes = (event.end - event.start) / 60000;
  const base = minutes < 15 ? 6 : minutes < 45 ? 12 : 18;
  return Math.round(base * (event.importance !== undefined ? 0.7 + event.importance * 0.6 : 1));
}
export function validateScene(
  scene: InPersonScene,
  event: ActivityEvent,
  maxDialogue = 1280,
  allowMarkdown = false,
  enforceBehavior = true,
) {
  SceneSchema.parse(scene);
  if (
    scene.worldId !== event.worldId ||
    scene.eventId !== event.id ||
    scene.start !== event.start ||
    scene.end !== event.end ||
    scene.participants.length !== event.participants.length ||
    new Set(scene.participants).size !== scene.participants.length ||
    scene.participants.some((id) => !event.participants.includes(id))
  )
    throw new Error('场景必须引用原共同活动');
  if (new Set(scene.phases.map((p) => p.id)).size !== scene.phases.length)
    throw new Error('重复的场景阶段编号');
  let last = event.start,
    dialogue = 0;
  for (const phase of scene.phases) {
    if (
      phase.start < last ||
      phase.end <= phase.start ||
      phase.end > event.end ||
      phase.participants.some((id) => !event.participants.includes(id)) ||
      new Set(phase.participants).size !== phase.participants.length
    )
      throw new Error('场景阶段时间或参与者无效');
    let at = phase.start;
    for (const entry of phase.entries) {
      if (entry.at < at || entry.at > phase.end) throw new Error('场景条目时间无效');
      at = entry.at;
      if (entry.speakerId && !phase.participants.includes(entry.speakerId))
        throw new Error('条目参与者不在场');
      if (entry.kind === 'dialogue') {
        dialogue++;
        if (
          !entry.speakerId ||
          !phase.participants.includes(entry.speakerId) ||
          Array.from(entry.text).length > 300
        )
          throw new Error('线下对白身份或长度无效');
        if (!allowMarkdown && markdownPattern.test(entry.text))
          throw new Error('线下对白含禁用 Markdown');
        if (enforceBehavior && (servicePattern.test(entry.text) || thoughtPattern.test(entry.text)))
          throw new Error('线下对白包含禁用的服务套话或心理描写');
      }
    }
    last = phase.end;
  }
  if (dialogue > maxDialogue) throw new Error('线下对白超出场景预算');
  return scene;
}
