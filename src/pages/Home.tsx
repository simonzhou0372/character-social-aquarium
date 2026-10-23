import { resolveObservation } from '../core/selective-observation';
import { ObservationSummary, useObservation } from '../components/ObservationManager';
import { formatWorldClock, calendarDate } from '../core/calendar';
import { featuredEvent } from '../core/observation';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowUpRight,
  ArrowRight,
  MessageCircle,
  Users,
  Activity,
  Clock3,
  Headphones,
  Sun,
  Plus,
  Eye,
} from 'lucide-react';
import { db } from '../data/db';
import { Avatar, Button, Empty, fmtTime } from '../components/ui';
export function Home({
  worldId,
  onNavigate,
  onChat,
  onCharacter,
}: {
  worldId: string;
  onNavigate: (page: string) => void;
  onChat: (id: string) => void;
  onCharacter: (id: string) => void;
}) {
  const observation = useObservation(worldId);
  const data = useLiveQuery(
    async () => ({
      world: await db.worlds.get(worldId),
      cp: await db.checkpoints.get(worldId),
      characters: await db.characters
        .where('id')
        .anyOf([...(await resolveObservation(worldId)).activeIds])
        .toArray(),
      members: await db.memberships.where('worldId').equals(worldId).toArray(),
      states: await db.states.where('worldId').equals(worldId).toArray(),
      events: await db.events.where('worldId').equals(worldId).reverse().sortBy('start'),
      convs: await db.conversations.where('worldId').equals(worldId).reverse().sortBy('lastAt'),
      messages: await db.messages.toArray(),
      cursors: await db.cursors.toArray(),
      groups: await db.groups.toArray(),
    }),
    [worldId],
  );
  const chars =
    data?.characters.filter(
      (c) =>
        c.entityMode !== 'background' &&
        data.members.some((m) => m.characterId === c.id) &&
        (!observation || observation.activeIds.has(c.id)),
    ) ?? [];
  const unread =
    data?.messages.filter(
      (m) =>
        data.convs.some((c) => c.id === m.conversationId) &&
        m.seq > (data.cursors.find((c) => c.id === `observer:${m.conversationId}`)?.seq ?? 0),
    ).length ?? 0;
  const now = data?.cp?.simTime ?? Date.now(),
    tz = data?.world?.timezone;
  const time = (at: number) => (data?.world ? formatWorldClock(data.world, at) : fmtTime(at, tz));
  return (
    <div className="home-page">
      <div className="page-heading home-heading">
        <div>
          <span className="eyebrow">TODAY'S OBSERVATION / 今日观察</span>
          <h1>
            世界在转，他们也在生活<span>✳</span>
          </h1>
          <p>把目光放慢一点，故事正在悄悄发生。</p>
        </div>
        <div className="world-clock">
          <Clock3 size={18} />
          <div>
            <strong>{time(now)}</strong>
            <span>
              {data?.world ? `${data.world.era ?? 'AD'} ${calendarDate(data.world, now)}` : ''} ·
              世界时间
            </span>
          </div>
        </div>
      </div>
      <ObservationSummary worldId={worldId} onEdit={() => onNavigate('observation')} />
      <Button onClick={() => onNavigate('reports')}>世界报告 · 查看历史与配置</Button>
      <section className="world-hero">
        <div className="hero-copy">
          <div className="hero-tags">
            <span className="hero-live">
              <i />
              {data?.cp?.paused ? 'WORLD ON PAUSE' : 'WORLD IS ALIVE'}
            </span>
            <span>
              {data?.world?.provenance
                ? '内置原设资料 · 模拟非正史'
                : data?.world?.id === 'w-harbor'
                  ? '原创演示世界'
                  : '自定义世界'}
            </span>
          </div>
          <h2>
            {data?.world?.name.split(' · ')[0] ?? '你的世界'}
            <em>一些平凡，又特别的日常。</em>
          </h2>
          <p>{data?.world?.description}</p>
          <button onClick={() => onNavigate('worlds')}>
            走进这个世界 <ArrowUpRight size={19} />
          </button>
          <div className="hero-bottom">
            <span>LOCAL FIRST. LIFE GOES ON.</span>
            <span>01 — ∞</span>
          </div>
        </div>
        <div className="hero-art" aria-hidden="true">
          {data?.world?.cover ? (
            <img className="world-cover" src={data.world.cover} alt={data.world.name} />
          ) : (
            <svg viewBox="0 0 600 320" preserveAspectRatio="xMidYMid slice">
              <rect width="600" height="320" fill="#cbdacb" />
              <circle cx="455" cy="82" r="54" fill="#f2ebc1" />
              <path d="M0 183Q120 160 220 180T600 171V320H0" fill="#87a9a5" />
              <path d="M0 222q170-40 320 0t280 0v98H0" fill="#a9c3b5" />
              <path d="M0 266q190-38 370 3t230 0" fill="none" stroke="#e4e7c9" strokeWidth="3" />
              <g stroke="#354a42" strokeWidth="4">
                <path d="M36 221V59m0 20h120l55 38H36m79-36v90M24 224h203" fill="none" />
                <path d="M245 224V147h109v77m-115-77h122l-13-20H254z" fill="#e8dfbc" />
                <path d="M269 225v-41h28v41m18-62h21v25h-21" fill="#82968b" />
                <path d="M389 224v-74h108v74m-120-74 65-41 66 41z" fill="#d5c6b0" />
                <path d="M410 224v-48h28v48m20-43h22v21h-22" fill="#80988b" />
                <path d="M0 228h600m-53 0V91m-13 14h28" fill="none" />
              </g>
              <path
                d="M110 260q10-24 23-24t23 24m-25-19v42m13-40 8 40"
                stroke="#394c42"
                strokeWidth="7"
                fill="none"
              />
              <circle cx="133" cy="221" r="10" fill="#394c42" />
              <path
                d="M177 267q8-28 18-28t21 28m-22-19-3 39m15-39 6 39"
                stroke="#7a6d54"
                strokeWidth="7"
                fill="none"
              />
              <circle cx="196" cy="226" r="10" fill="#7a6d54" />
              <path d="m308 61 9-5 9 5m14 7 8-4 8 4" stroke="#5a7568" strokeWidth="2" fill="none" />
            </svg>
          )}
          <span className="art-sticker">
            <Sun size={18} /> SLOW DAYS, GOOD COMPANY.
          </span>
          <span className="hero-coordinate">
            35° 41′ N / 139° 41′ E<br />A FICTIONAL LITTLE TOWN
          </span>
        </div>
      </section>
      <div className="stats-grid">
        {[
          [Users, chars.length, '在这个世界的角色', '每一个，都有自己的节奏'],
          [MessageCircle, unread, '条待看的消息', '你不在时，话题也继续着'],
          [Activity, data?.events.length ?? 0, '个生活片段', '把细小的日常留在这里'],
          [
            Clock3,
            data?.states.filter((s) => s.activity === '一起活动').length ?? 0,
            '人正在共同活动',
            '此刻，有人恰好在一起',
          ],
        ].map(([Icon, value, label, note], i) => (
          <div className="stat-card" key={i}>
            <div className="stat-top">
              {typeof Icon !== 'string' && typeof Icon !== 'number' && <Icon size={19} />}
              <span>0{i + 1}</span>
            </div>
            <div>
              <b>{String(value).padStart(2, '0')}</b>
              <span>{String(label)}</span>
            </div>
            <small>{String(note)}</small>
          </div>
        ))}
      </div>
      <section className="people-section">
        <div className="section-title">
          <div>
            <span className="eyebrow">RIGHT HERE, RIGHT NOW</span>
            <h2>
              他们的此刻<span className="section-count">{chars.length}</span>
            </h2>
          </div>
          <button className="text-button" onClick={() => onNavigate('characters')}>
            角色图鉴
            <ArrowUpRight size={16} />
          </button>
        </div>
        <div className="people-strip">
          {chars.map((c) => {
            const state = data?.states.find((s) => s.characterId === c.id);
            return (
              <button key={c.id} className="person-tile" onClick={() => onCharacter(c.id)}>
                <div className="person-portrait" style={{ background: c.color }}>
                  <Avatar character={c} size={108} />
                  <span
                    className={`status-dot ${state?.phone === 0 ? 'sleep' : state && state.phone < 0.3 ? 'busy' : ''}`}
                  />
                </div>
                <strong>{c.name}</strong>
                <span>{state?.activity ?? '还没有日程'}</span>
                <small>{state?.location ?? '等待世界开始'}</small>
              </button>
            );
          })}
          <button className="add-person-tile" onClick={() => onNavigate('characters')}>
            <Plus size={25} />
            <span>
              新朋友
              <br />
              新故事
            </span>
          </button>
        </div>
      </section>
      <div className="home-bottom">
        <section className="panel recent-conversations">
          <div className="section-title">
            <div>
              <span className="eyebrow">OVERHEARD IN TOWN</span>
              <h2>不妨，听听他们在聊什么</h2>
            </div>
            <button
              className="icon-button"
              aria-label="查看全部会话"
              onClick={() => onNavigate('chats')}
            >
              <ArrowUpRight size={20} />
            </button>
          </div>
          {data?.convs.slice(0, 3).map((c) => {
            const last = data.messages
              .filter((m) => m.conversationId === c.id)
              .sort((a, b) => a.simAt - b.simAt || a.seq - b.seq)
              .at(-1);
            return (
              <button className="home-conversation" key={c.id} onClick={() => onChat(c.id)}>
                <span className="group-avatar">
                  {c.kind === 'group' ? <Users size={22} /> : <MessageCircle size={22} />}
                </span>
                <div>
                  <h3>
                    {c.name}
                    <time>{last && time(last.simAt)}</time>
                  </h3>
                  <p>{last?.text ?? '这里还很安静。'}</p>
                </div>
                <ArrowRight size={17} />
              </button>
            );
          })}
          {!data?.convs.length && (
            <Empty title="暂时还很安静" description="添加角色和团体，让交流慢慢开始。" />
          )}
          <div className="panel-footer">
            <Eye size={14} />
            <span>旁观他们的交流，不必先说第一句话。</span>
          </div>
        </section>
        <section className="panel recent-events">
          <div className="section-title">
            <div>
              <span className="eyebrow">SMALL MOMENTS</span>
              <h2>生活留下的痕迹</h2>
            </div>
            <button
              className="icon-button"
              aria-label="查看生活时间轴"
              onClick={() => onNavigate('timeline')}
            >
              <ArrowUpRight size={20} />
            </button>
          </div>
          {data?.events
            .filter((e) => featuredEvent(e))
            .slice(0, 4)
            .map((e) => (
              <button className="mini-event" key={e.id} onClick={() => onNavigate('timeline')}>
                <span className={`mini-event-icon ${e.type}`}>
                  <Headphones size={16} />
                </span>
                <div>
                  <strong>{e.description}</strong>
                  <small>
                    {time(e.start)} · {e.location}
                  </small>
                </div>
              </button>
            ))}
          {!data?.events.some((e) => featuredEvent(e)) && (
            <Empty
              title="此刻，平静地生活着"
              description="精选片段会出现在这里，日常状态可以在时间轴查看。"
            />
          )}
        </section>
      </div>
      <footer className="home-footer">
        <span>✳ AQUARIUM OBSERVATION CLUB</span>
        <span>他们的故事，正在继续。</span>
      </footer>
    </div>
  );
}
