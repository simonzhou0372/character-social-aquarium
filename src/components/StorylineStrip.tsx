import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowUpRight, MessageCircle, MapPin, Footprints } from 'lucide-react';
import { db } from '../data/db';
import { loadStoryThreads } from '../core/storyline';
import { formatWorldClock } from '../core/calendar';
import type { InPersonScene } from '../core/types';
import { SceneDetail } from '../pages/Scenes';

/**
 * 首页的「剧情线」：把同一段经历的线上约定、线下场景和事后回应
 * 放在一张卡里，让用户第一眼看见故事是连续发生的。
 */
export function StorylineStrip({
  worldId,
  onChat,
  onNavigate,
  variant = 'game',
}: {
  worldId: string;
  onChat: (id: string) => void;
  onNavigate: (page: string) => void;
  variant?: 'game' | 'classic';
}) {
  const [scene, setScene] = useState<InPersonScene>();
  const data = useLiveQuery(async () => {
    const cp = await db.checkpoints.get(worldId);
    const threads = await loadStoryThreads(worldId, db, {
      now: cp?.simTime ?? Date.now(),
      limit: 6,
    });
    const ids = [...new Set(threads.flatMap((t) => t.participants))];
    return {
      world: await db.worlds.get(worldId),
      threads,
      characters: ids.length ? await db.characters.where('id').anyOf(ids).toArray() : [],
    };
  }, [worldId]);
  if (!data?.threads.length) return null;
  const time = (at: number) =>
    data.world ? formatWorldClock(data.world, at) : new Date(at).toLocaleTimeString();
  const name = (id: string) => data.characters.find((c) => c.id === id)?.name ?? '某人';
  const threads = data.threads.filter((t) => t.lead.length || t.follow.length).slice(0, 4);
  if (!threads.length) return null;
  return (
    <section className={`storyline-block ${variant}`}>
      <div className="section-title storyline-heading">
        <div>
          <span className="eyebrow">STORY THREADS / 剧情线</span>
          <h2>线上与线下，是同一段故事</h2>
        </div>
        <button className="text-button" onClick={() => onNavigate('timeline')}>
          看完整时间轴 <ArrowUpRight size={16} />
        </button>
      </div>
      <div className="storyline-list">
        {threads.map((thread) => {
          const lead = thread.lead.at(-1);
          const follow = thread.follow[0];
          return (
            <article className="storyline-card" key={thread.id}>
              <header>
                <time>{time(thread.start)}</time>
                <span>
                  <MapPin size={12} /> {thread.location}
                </span>
                <span className="storyline-cast">
                  {thread.participants.slice(0, 4).map(name).join('、')}
                </span>
              </header>
              <div className="storyline-rail">
                {lead ? (
                  <button
                    className="storyline-node online lead"
                    onClick={() => onChat(lead.conversationId)}
                    title={lead.text}
                  >
                    <span className="storyline-node-tag">
                      <MessageCircle size={12} /> {thread.derived ? '同期线上' : '线上约定'}
                    </span>
                    <span className="storyline-node-text">
                      <b>{name(lead.senderId)}</b> {lead.text}
                    </span>
                    <time>{time(lead.at)}</time>
                  </button>
                ) : (
                  <div className="storyline-node ghost">没有留下前置线上消息</div>
                )}
                <button
                  className="storyline-node offline"
                  onClick={() => setScene(thread.scene)}
                  title={thread.title}
                >
                  <span className="storyline-node-tag">
                    <Footprints size={12} /> 线下见面
                  </span>
                  <span className="storyline-node-text">
                    <b>{thread.title}</b>
                    {thread.recap && <em>{thread.recap.slice(0, 42)}…</em>}
                  </span>
                  <time>{time(thread.start)}</time>
                </button>
                {follow ? (
                  <button
                    className="storyline-node online follow"
                    onClick={() => onChat(follow.conversationId)}
                    title={follow.text}
                  >
                    <span className="storyline-node-tag">
                      <MessageCircle size={12} /> {thread.derived ? '同期线上' : '线上回味'}
                    </span>
                    <span className="storyline-node-text">
                      <b>{name(follow.senderId)}</b> {follow.text}
                    </span>
                    <time>{time(follow.at)}</time>
                  </button>
                ) : (
                  <div className="storyline-node ghost">没有留下后续线上消息</div>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {scene && <SceneDetail scene={scene} onClose={() => setScene(undefined)} />}
    </section>
  );
}
