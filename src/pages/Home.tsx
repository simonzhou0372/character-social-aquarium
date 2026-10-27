import { ConversationAvatar } from '../components/ConversationAvatar';
import { StoryProgress } from '../components/NovelSettings';
import { resolveObservation } from '../core/selective-observation';
import { ObservationSummary, useObservation } from '../components/ObservationManager';
import { formatWorldClock, calendarDate, worldTime } from '../core/calendar';
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
  MapPin,
  Radio,
  ScanLine,
  Sparkles,
  ChevronRight,
} from 'lucide-react';
import { db } from '../data/db';
import { Avatar, Button, Empty, fmtTime } from '../components/ui';
import { useUIPreferences } from '../components/ui-preferences';
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
  const { mode } = useUIPreferences();
  const observation = useObservation(worldId);
  const data = useLiveQuery(async () => {
    const convs = await db.conversations
      .where('worldId')
      .equals(worldId)
      .reverse()
      .sortBy('lastAt');
    return {
      world: await db.worlds.get(worldId),
      cp: await db.checkpoints.get(worldId),
      characters: await db.characters
        .where('id')
        .anyOf([...(await resolveObservation(worldId)).activeIds])
        .toArray(),
      members: await db.memberships.where('worldId').equals(worldId).toArray(),
      states: await db.states.where('worldId').equals(worldId).toArray(),
      events: await db.events.where('worldId').equals(worldId).reverse().sortBy('start'),
      convs,
      messages: await db.messages.toArray(),
      cursors: await db.cursors.toArray(),
      groups: await db.groups.toArray(),
      avatarCharacters: await db.characters
        .where('id')
        .anyOf([...new Set(convs.slice(0, 3).flatMap((c) => c.participants))])
        .toArray(),
      settings: await db.settings.get('app'),
    };
  }, [worldId]);
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
  if (mode === 'classic')
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
        <StoryProgress worldId={worldId} />
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
                <path
                  d="m308 61 9-5 9 5m14 7 8-4 8 4"
                  stroke="#5a7568"
                  strokeWidth="2"
                  fill="none"
                />
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
                  <ConversationAvatar
                    conversation={c}
                    characters={data.avatarCharacters}
                    user={{ name: data.settings?.nickname, avatar: data.settings?.userAvatar }}
                  />
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
  const featured = data?.events.filter((e) => featuredEvent(e)).slice(0, 4) ?? [];
  const pulse = data?.states.filter((s) => s.phone > 0.3) ?? [];
  const hour = data?.world && data?.cp ? worldTime(data.world, data.cp.simTime).hour : 12;
  const phaseLabel =
    hour < 5 || hour >= 21
      ? '深夜'
      : hour < 8
        ? '清晨'
        : hour < 17
          ? '白昼'
          : hour < 19
            ? '黄昏'
            : '夜晚';
  const activeNames = chars
    .filter((c) => data?.states.find((s) => s.characterId === c.id)?.activity === '一起活动')
    .map((c) => c.name)
    .join('、');
  return (
    <div className="home-page game-home">
      <div className="game-home-kicker">
        <span className="eyebrow">TODAY'S OBSERVATION / 今日观察</span>
        <div>
          <span className={`home-live-pill ${data?.cp?.paused ? 'paused' : ''}`}>
            <i />
            {data?.cp?.paused ? 'TIME FROZEN' : 'WORLD IS ALIVE'}
          </span>
          <button className="home-report-link" onClick={() => onNavigate('reports')}>
            <BookOpenIcon /> 世界报告 <ArrowUpRight size={14} />
          </button>
        </div>
      </div>

      <section className="world-stage">
        <div className="world-stage-visual" aria-hidden="true">
          {data?.world?.cover ? (
            <img src={data.world.cover} alt="" />
          ) : (
            <div className="stage-fallback">
              <span className="stage-sun" />
              <span className="stage-horizon" />
              <span className="stage-building building-a" />
              <span className="stage-building building-b" />
              <span className="stage-hairline line-a" />
              <span className="stage-hairline line-b" />
            </div>
          )}
          <span className="stage-grade" />
          <span className="stage-dots" />
          <span className="stage-index">WORLD / 01</span>
          <span className="stage-corner corner-a" />
          <span className="stage-corner corner-b" />
        </div>
        <div className="world-stage-copy">
          <span className="stage-tag">
            <Radio size={13} />
            {data?.world?.provenance
              ? '内置原设资料 · 模拟非正史'
              : data?.world?.id === 'w-harbor'
                ? '原创演示世界'
                : '自定义世界'}
          </span>
          <h1 aria-label="世界在转，他们也在生活">
            世界在转，
            <br />
            <em>他们也在生活</em>
            <span>✳</span>
          </h1>
          <p className="stage-description">{data?.world?.description}</p>
          <div className="stage-actions">
            <button className="stage-primary" onClick={() => onNavigate('chats')}>
              <MessageCircle size={17} />
              听听他们在聊什么
              <ArrowUpRight size={18} />
            </button>
            <button className="stage-secondary" onClick={() => onNavigate('worlds')}>
              走进世界档案
            </button>
          </div>
          <div className="stage-meta">
            <span>
              <MapPin size={13} />
              {data?.world?.locations.length ?? 0} 个地点
            </span>
            <span>
              <Users size={13} />
              {chars.length} 位可观察角色
            </span>
            <span>
              <Activity size={13} />
              {pulse.length} 人此刻在线
            </span>
            <span className="stage-phase-label">
              <i />
              {phaseLabel}
            </span>
          </div>
        </div>
        <aside className="stage-clock" aria-label="当前世界时间">
          <span className="stage-clock-label">LOCAL WORLD TIME</span>
          <strong key={time(now)}>{time(now)}</strong>
          <small>
            {data?.world ? `${data.world.era ?? 'AD'} ${calendarDate(data.world, now)}` : ''}
          </small>
          <span className={`stage-clock-state ${data?.cp?.paused ? 'paused' : ''}`}>
            <i />
            {data?.cp?.paused ? '世界暂停' : `${data?.cp?.speed ?? 30}× 时间流`}
          </span>
          <span className="stage-clock-rule" aria-hidden="true" />
        </aside>
        <div className="stage-cast" aria-hidden="true">
          {chars.slice(0, 4).map((c, i) => (
            <div
              className="stage-cast-person"
              key={c.id}
              style={{ '--cast-color': c.color, '--cast-i': i } as React.CSSProperties}
            >
              <Avatar character={c} size={82} />
            </div>
          ))}
        </div>
      </section>

      <div className="stage-orbit-strip game-only" aria-hidden="true">
        <span>LOCAL FIRST</span>
        <i />
        <span>LIFE GOES ON</span>
        <i />
        <span>OBSERVE WITHOUT INTERRUPTION</span>
        <i />
        <span>{activeNames ? `${activeNames} 正在一起` : '所有人都在自己的节奏里'}</span>
      </div>

      <div className="game-observation-row">
        <div className="game-observation-main">
          <section className="game-brief">
            <div className="game-brief-top">
              <span>WORLD BRIEF / 世界简报</span>
              <span className={`game-brief-signal ${data?.cp?.paused ? 'paused' : ''}`}>
                <i />
                {data?.cp?.paused ? 'STANDBY' : 'ACTIVE'}
              </span>
            </div>
            <h3>{data?.world?.name ?? '你的世界'}</h3>
            <p>
              {data?.cp?.paused
                ? '时间暂时冻结。已经发生的生活与聊天仍可翻阅，继续观察后故事才会再次流动。'
                : '世界正在按自己的节奏运行。角色会睡觉、工作、主动找人说话，也会在繁忙时晚些回复。'}
            </p>
            <div className="game-brief-facts">
              <span>
                <small>LOCAL TIME</small>
                <b>{time(now)}</b>
              </span>
              <span>
                <small>ACTIVE CAST</small>
                <b>
                  {pulse.length} / {chars.length}
                </b>
              </span>
              <span>
                <small>TOGETHER</small>
                <b>{activeNames || '各自生活'}</b>
              </span>
              <span>
                <small>MODE</small>
                <b>{data?.cp?.mode === 'demo' ? 'DEMO' : 'LIVE AI'}</b>
              </span>
            </div>
          </section>
          <StoryProgress worldId={worldId} />
        </div>
        <ObservationSummary worldId={worldId} onEdit={() => onNavigate('observation')} />
      </div>

      <section className="game-metrics" aria-label="世界状态统计">
        {[
          [Users, chars.length, '可观察角色', '每一个都有独立的作息', 'ROSTER'],
          [MessageCircle, unread, '待读消息', '话题没有因为离开而停下', 'SIGNAL'],
          [Activity, data?.events.length ?? 0, '生活片段', '细小日常持续归档', 'ARCHIVE'],
          [
            Sparkles,
            data?.states.filter((s) => s.activity === '一起活动').length ?? 0,
            '共同活动中',
            '此刻有人恰好在一起',
            'SOCIAL',
          ],
        ].map(([Icon, value, label, note, code], i) => (
          <div className="game-metric" key={i}>
            <span className="metric-code">
              {String(code)} 0{i + 1}
            </span>
            <span className="metric-icon">
              {typeof Icon !== 'string' && typeof Icon !== 'number' && <Icon size={18} />}
            </span>
            <div>
              <b key={String(value)} className="metric-number">
                {String(value).padStart(2, '0')}
              </b>
              <strong>{String(label)}</strong>
            </div>
            <small>{String(note)}</small>
            <span className="metric-edge" aria-hidden="true" />
          </div>
        ))}
      </section>

      <section className="game-roster-section">
        <div className="game-section-heading">
          <div>
            <span className="eyebrow">RIGHT HERE, RIGHT NOW</span>
            <h2>
              他们的此刻 <span>{String(chars.length).padStart(2, '0')}</span>
            </h2>
          </div>
          <div className="game-heading-actions">
            <button className="game-link-button" onClick={() => onNavigate('characters')}>
              + 添加角色
            </button>
            <button className="game-link-button" onClick={() => onNavigate('characters')}>
              打开角色图鉴 <ArrowUpRight size={16} />
            </button>
          </div>
        </div>
        <div className="game-roster">
          {chars.map((c, i) => {
            const state = data?.states.find((s) => s.characterId === c.id);
            const groupName = c.tags[0] || c.source || '观察对象';
            return (
              <article
                className="game-person-card"
                key={c.id}
                style={
                  {
                    '--char-color': c.color,
                    '--char-index': String(i + 1).padStart(2, '0'),
                  } as React.CSSProperties
                }
              >
                <button
                  className="game-person-main"
                  onClick={() => onCharacter(c.id)}
                  aria-label={`查看 ${c.name} 的档案`}
                >
                  <span className="game-person-art">
                    <span className="game-person-number">NO. {String(i + 1).padStart(2, '0')}</span>
                    <span className="game-person-stripes" aria-hidden="true" />
                    <Avatar character={c} size={168} />
                    <span
                      className={`game-person-status ${state?.phone === 0 ? 'sleep' : state && state.phone < 0.3 ? 'busy' : ''}`}
                    >
                      <i />
                      {state?.activity ?? '待机'}
                    </span>
                  </span>
                  <span className="game-person-copy">
                    <span className="game-person-group">{groupName}</span>
                    <strong>{c.name}</strong>
                    <span className="game-person-location">
                      <MapPin size={12} />
                      {state?.location ?? '尚未开始生活'}
                    </span>
                    <span className="game-person-tags">
                      {(c.tags.length ? c.tags : [c.gender || '未设定', '可互动'])
                        .slice(0, 2)
                        .map((t) => (
                          <i key={t}>{t}</i>
                        ))}
                    </span>
                  </span>
                  <span className="game-person-arrow">
                    <ArrowUpRight size={18} />
                  </span>
                </button>
              </article>
            );
          })}
        </div>
      </section>

      <div className="game-feed-grid">
        <section className="game-panel game-conversations">
          <div className="game-panel-heading">
            <div>
              <span className="eyebrow">OVERHEARD IN TOWN</span>
              <h2>不妨，听听他们在聊什么</h2>
            </div>
            <button
              className="game-panel-link"
              aria-label="查看全部会话"
              onClick={() => onNavigate('chats')}
            >
              全部会话 <ArrowUpRight size={15} />
            </button>
          </div>
          <div className="game-conversation-list">
            {data?.convs.slice(0, 4).map((c, i) => {
              const last = data.messages
                .filter((m) => m.conversationId === c.id)
                .sort((a, b) => a.simAt - b.simAt || a.seq - b.seq)
                .at(-1);
              return (
                <button
                  className="game-conversation"
                  key={c.id}
                  onClick={() => onChat(c.id)}
                  style={{ '--row-index': i } as React.CSSProperties}
                >
                  <span className="game-conversation-index">{String(i + 1).padStart(2, '0')}</span>
                  <ConversationAvatar
                    conversation={c}
                    characters={data.avatarCharacters}
                    user={{ name: data.settings?.nickname, avatar: data.settings?.userAvatar }}
                  />
                  <span className="game-conversation-copy">
                    <strong>
                      {c.name}
                      <time>{last && time(last.simAt)}</time>
                    </strong>
                    <span>{last?.text ?? '这里还很安静。'}</span>
                  </span>
                  <ArrowRight size={17} />
                </button>
              );
            })}
            {!data?.convs.length && (
              <Empty title="暂时还很安静" description="添加角色和团体，让交流慢慢开始。" />
            )}
          </div>
          <div className="game-panel-foot">
            <Eye size={14} />
            <span>旁观他们的交流，不必先说第一句话。</span>
            <span className="live-dot" />
            <small>LIVE</small>
          </div>
        </section>
        <section className="game-panel game-events">
          <div className="game-panel-heading">
            <div>
              <span className="eyebrow">SMALL MOMENTS</span>
              <h2>生活留下的痕迹</h2>
            </div>
            <button
              className="game-panel-link"
              aria-label="查看生活时间轴"
              onClick={() => onNavigate('timeline')}
            >
              时间轴 <ArrowUpRight size={15} />
            </button>
          </div>
          <div className="game-event-list">
            {featured.map((e, i) => (
              <button
                className={`game-event-row type-${e.type}`}
                key={e.id}
                onClick={() => onNavigate('timeline')}
              >
                <span className="game-event-time">
                  <b>{time(e.start)}</b>
                  <small>{String(i + 1).padStart(2, '0')}</small>
                </span>
                <span className="game-event-icon">
                  <Headphones size={16} />
                </span>
                <span className="game-event-copy">
                  <strong>{e.description}</strong>
                  <small>
                    <MapPin size={11} />
                    {e.location}
                  </small>
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
            {!featured.length && (
              <Empty
                title="此刻，平静地生活着"
                description="精选片段会出现在这里，日常状态可以在时间轴查看。"
              />
            )}
          </div>
          <div className="game-panel-foot">
            <ScanLine size={14} />
            <span>只展示值得回看的片段。</span>
          </div>
        </section>
      </div>
      <footer className="home-footer game-home-footer">
        <span>✳ AQUARIUM OBSERVATION CLUB / LOCAL ARCHIVE</span>
        <span>他们的故事，正在继续。</span>
      </footer>
    </div>
  );
}

function BookOpenIcon() {
  return <Sparkles size={14} />;
}
