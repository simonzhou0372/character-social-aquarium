import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import type { MajorEvent } from '../core/types';
import { formatWorldTime } from '../core/calendar';
import { Button, Modal, Select, Status, Avatar, Empty } from '../components/ui';
import { SceneDetail } from './Scenes';
import { useUIPreferences } from '../components/ui-preferences';
export function MajorEventDetail({
  eventId,
  onClose,
  onConversation,
}: {
  eventId: string;
  onClose: () => void;
  onConversation?: (id: string) => void;
}) {
  const data = useLiveQuery(async () => {
    const event = await db.majorEvents.get(eventId);
    return {
      event,
      activity: event ? await db.events.get(event.eventId) : undefined,
      groups: event ? await db.groups.where('id').anyOf(event.groupIds).toArray() : [],
      world: event ? await db.worlds.get(event.worldId) : undefined,
      chars: await db.characters.toArray(),
      scenes: event ? await db.scenes.where('eventId').equals(event.eventId).toArray() : [],
      jobs: event
        ? await db.contentJobs
            .where('worldId')
            .equals(event.worldId)
            .and((j) => j.event.id === event.eventId)
            .toArray()
        : [],
      messages: event ? await db.messages.where('eventId').equals(event.eventId).toArray() : [],
    };
  }, [eventId]);
  const [scene, setScene] = useState('');
  const { mode: uiMode } = useUIPreferences();
  if (!data?.event) return null;
  const e = data.event;
  return (
    <Modal title={uiMode === 'game' ? '重大事件记录' : e.title} onClose={onClose} wide>
      {uiMode === 'game' && (
        <section className={`major-event-hero type-${e.type.replace(/[^a-z0-9-]/gi, '-')}`}>
          <div className="major-event-hero-top">
            <span>MAJOR EVENT RECORD / 重大事件</span>
            <span className="major-event-importance">
              IMPORTANCE {Math.round(e.importance * 100)}
            </span>
          </div>
          <h2>{e.title}</h2>
          <p>
            {data.world && formatWorldTime(data.world, e.timestamp)} ·{' '}
            {data.activity?.location ?? '未知地点'}
            {data.groups.length ? ` · ${data.groups.map((g) => g.name).join('、')}` : ''} ·{' '}
            {e.status === 'contentPending' ? '细节生成中' : '已归档'}
          </p>
          <div className="major-event-hero-cast">
            {e.participantIds.slice(0, 8).map((id) => (
              <span key={id} title={data.chars.find((c) => c.id === id)?.name}>
                <Avatar character={data.chars.find((c) => c.id === id)} size={46} />
                <small>{data.chars.find((c) => c.id === id)?.name}</small>
              </span>
            ))}
            <span className="major-event-sigil" aria-hidden="true">
              ✦
            </span>
          </div>
          <span className="major-event-hero-line" aria-hidden="true" />
        </section>
      )}
      {uiMode === 'classic' && (
        <>
          <p>
            {data.world && formatWorldTime(data.world, e.timestamp)} ·{' '}
            {e.status === 'contentPending' ? '事件已发生，细节生成中' : '已记录'}
          </p>
          <div className="toolbar">
            {e.participantIds.map((id) => (
              <span key={id}>
                <Avatar character={data.chars.find((c) => c.id === id)} size={30} />
                {data.chars.find((c) => c.id === id)?.name}
              </span>
            ))}
          </div>
          <p>
            {data.activity?.location}
            {data.groups.length ? ` · ${data.groups.map((g) => g.name).join('、')}` : ''}
          </p>
        </>
      )}
      <p>{e.description}</p>
      <h3>已确认的后续影响</h3>
      {e.consequences.map((c, i) => (
        <p key={i}>
          {c.description}
          {c.delta !== undefined ? `（亲近 ${c.delta > 0 ? '+' : ''}${c.delta}）` : ''}
        </p>
      ))}
      {data.scenes.map((s) => (
        <Button key={s.id} onClick={() => setScene(s.id)}>
          查看线下观察 · {s.generationStatus ?? 'complete'}
        </Button>
      ))}
      {data.jobs
        .filter((j) => j.status === 'failed')
        .map((j) => (
          <Status key={j.id} error>
            {j.error}
            <Button
              onClick={async () => {
                const { retryContent } = await import('../ai/content-queue');
                await retryContent(j.id);
              }}
            >
              继续生成
            </Button>
          </Status>
        ))}
      {[...new Set(data.messages.map((m) => m.conversationId))].map((id) => (
        <Button key={id} onClick={() => onConversation?.(id)}>
          查看相关线上聊天
        </Button>
      ))}
      {scene && data.scenes.find((s) => s.id === scene) && (
        <SceneDetail
          scene={data.scenes.find((s) => s.id === scene)!}
          onClose={() => setScene('')}
        />
      )}
    </Modal>
  );
}
export function MajorBanner({
  worldId,
  onOpen,
}: {
  worldId: string;
  onOpen: (id: string) => void;
}) {
  const rows = useLiveQuery(
    async () => ({
      notices: await db.notifications
        .where('worldId')
        .equals(worldId)
        .and((n) => !n.readAt && !n.dismissedAt)
        .toArray(),
      events: await db.majorEvents.where('worldId').equals(worldId).toArray(),
      world: await db.worlds.get(worldId),
      chars: await db.characters.toArray(),
    }),
    [worldId],
  );
  const notice = rows?.notices.sort((a, b) => b.createdAt - a.createdAt)[0],
    event = rows?.events.find((e) => e.id === notice?.eventId);
  if (!event || !notice) return null;
  return (
    <aside className="major-banner" data-type={event.type} role="status">
      <span className="major-banner-kicker">MAJOR EVENT / {event.type || 'WORLD'}</span>
      <strong>
        ✦ {rows!.notices.length > 1 ? `${rows!.notices.length} 件重大事件` : event.title}
      </strong>
      <p>
        {rows!.notices.some((n) => n.recovery)
          ? `你离开的这段时间里发生了 ${rows!.notices.filter((n) => n.recovery).length} 件重大事件。`
          : event.description.slice(0, 100)}
        <br />
        {event.participantIds
          .map((id) => rows?.chars.find((c) => c.id === id)?.name)
          .join('、')} · {rows?.world && formatWorldTime(rows.world, event.timestamp)}
      </p>
      <Button
        onClick={async () => {
          await db.notifications.update(notice.id, { readAt: Date.now() });
          onOpen(event.id);
        }}
      >
        查看事件
      </Button>
      <Button
        onClick={() =>
          void db.notifications
            .where('worldId')
            .equals(worldId)
            .modify((n) => {
              if (!n.readAt) n.dismissedAt = Date.now();
            })
        }
      >
        收起提示
      </Button>
    </aside>
  );
}
export function MajorEvents({
  worldId,
  onOpen,
}: {
  worldId: string;
  onOpen: (id: string) => void;
}) {
  const data = useLiveQuery(
    async () => ({
      events: await db.majorEvents.toArray(),
      notifications: await db.notifications.toArray(),
      worlds: await db.worlds.filter((w) => !w.deletedAt).toArray(),
    }),
    [],
  );
  const [world, setWorld] = useState(worldId),
    [status, setStatus] = useState('all'),
    [importance, setImportance] = useState(0);
  const events =
    data?.events
      .filter(
        (e) =>
          (!world || e.worldId === world) &&
          e.importance >= importance &&
          (status === 'all' ||
            data.notifications.some(
              (n) => n.eventId === e.id && (status === 'read' ? !!n.readAt : !n.readAt),
            )),
      )
      .sort((a, b) => b.timestamp - a.timestamp) ?? [];
  return (
    <div>
      <div className="page-heading">
        <div>
          <span className="eyebrow">WORLD EVENTS</span>
          <h1>值得记住的重要时刻</h1>
        </div>
      </div>
      <div className="toolbar">
        <Select aria-label="事件世界" value={world} onChange={(e) => setWorld(e.target.value)}>
          <option value="">全部世界</option>
          {data?.worlds.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="事件阅读状态"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="all">全部通知</option>
          <option value="unread">未读</option>
          <option value="read">已读</option>
        </Select>
        <Select
          aria-label="事件重要程度"
          value={importance}
          onChange={(e) => setImportance(Number(e.target.value))}
        >
          <option value="0">全部重要程度</option>
          <option value=".9">高度重要</option>
          <option value=".95">极重要</option>
        </Select>
      </div>
      <div className="major-list">
        {events.map((e) => (
          <article className="panel" key={e.id}>
            <h3>{e.title}</h3>
            <p>{e.description}</p>
            <p>
              {data?.worlds.find((w) => w.id === e.worldId) &&
                formatWorldTime(data.worlds.find((w) => w.id === e.worldId)!, e.timestamp)}
            </p>
            <Button
              onClick={async () => {
                const n = data?.notifications.find((n) => n.eventId === e.id);
                if (n) await db.notifications.update(n.id, { readAt: Date.now() });
                onOpen(e.id);
              }}
            >
              阅读事件
            </Button>
          </article>
        ))}
      </div>
      {!events.length && (
        <Empty title="还没有大型事件" description="在世界编辑中开启大型事件并设置最大发生间隔。" />
      )}
    </div>
  );
}
