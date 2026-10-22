import { SceneDetail } from './Scenes';
import { timelineMatches, mergeRoutine, type TimelineView } from '../core/observation';
import {
  calendarDate,
  calendarTick,
  formatWorldTime,
  formatWorldClock,
  addMinutes,
  type WorldDateTime,
} from '../core/calendar';
import { WorldDateEditor } from '../components/WorldDateEditor';
import type { InPersonScene } from '../core/types';
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  MessageCircle,
} from 'lucide-react';
import { db } from '../data/db';
import { DAY, type ActivityEvent } from '../core/types';
import { Avatar, Button, Select, Modal, Empty, fmtTime } from '../components/ui';

export function Timeline({
  worldId,
  onConversation,
}: {
  worldId: string;
  onConversation: (id: string) => void;
}) {
  const data = useLiveQuery(
    async () => ({
      scenes: await db.scenes.where('worldId').equals(worldId).toArray(),
      events: await db.events.where('worldId').equals(worldId).reverse().sortBy('start'),
      chars: await db.characters.toArray(),
      world: await db.worlds.get(worldId),
      checkpoint: await db.checkpoints.get(worldId),
      groups: await db.groups.toArray(),
      gm: await db.groupMembers.where('worldId').equals(worldId).toArray(),
    }),
    [worldId],
  );
  const [date, setDate] = useState(''),
    [scope, setScope] = useState('day'),
    [person, setPerson] = useState(''),
    [group, setGroup] = useState(''),
    [kind, setKind] = useState(''),
    [view, setView] = useState<TimelineView>('featured'),
    [scene, setScene] = useState<InPersonScene>(),
    [zoom, setZoom] = useState(1),
    [selected, setSelected] = useState<ActivityEvent>();
  const tz = data?.world?.timezone ?? 'Asia/Shanghai';
  const world = data?.world;
  const shownDate =
    date || (world ? calendarDate(world, data?.checkpoint?.simTime ?? Date.now()) : '2026-01-01');
  const parts = shownDate.split('-').map(Number);
  const dateValue: WorldDateTime = {
    year: parts[0],
    month: parts[1],
    day: parts[2],
    hour: 0,
    minute: 0,
  };
  const shiftCalendar = (days: number) => {
    try {
      const d = addMinutes(dateValue, days * 1440);
      return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
    } catch {
      return shownDate;
    }
  };
  let start = 0,
    end = Number.MAX_SAFE_INTEGER;
  try {
    if (world?.calendarAnchor) {
      start = calendarTick(world, dateValue);
      end = start + (scope === 'week' ? 7 : 1) * DAY;
    }
  } catch {
    /* invalid date editor values keep saved history available */
  }
  const time = (at: number) => (world ? formatWorldClock(world, at) : fmtTime(at, tz));
  const events = mergeRoutine(
    data?.events.filter(
      (e) =>
        timelineMatches(
          e,
          view,
          data.scenes.some((s) => s.eventId === e.id),
        ) &&
        e.start < end &&
        e.end > start &&
        (!person || e.participants.includes(person)) &&
        (!kind || e.type === kind) &&
        (!group ||
          e.participants.some((id) =>
            data.gm.some((m) => m.groupId === group && m.characterId === id),
          )),
    ) ?? [],
  );
  const shift = (days: number) => setDate(shiftCalendar(days));
  return (
    <div>
      <div className="page-heading">
        <div>
          <span className="eyebrow">LIFE LOG / 生活时间轴</span>
          <h1>
            没有被看见的时间，也在流动<span>◷</span>
          </h1>
          <p>每一段空白与交集，都是他们真实经历的日常。</p>
        </div>
      </div>
      <div className="timeline-toolbar">
        <Button aria-label="前一天" onClick={() => shift(-1)}>
          <ChevronLeft size={17} />
        </Button>
        <WorldDateEditor
          label="跳转日期"
          value={dateValue}
          onChange={(d) => {
            if (
              d.year >= 1 &&
              d.year <= 999999 &&
              d.month >= 1 &&
              d.month <= 12 &&
              d.day >= 1 &&
              d.day <= 31
            )
              setDate(
                `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`,
              );
          }}
        />

        <Button aria-label="后一天" onClick={() => shift(1)}>
          <ChevronRight size={17} />
        </Button>
        <Select aria-label="时间尺度" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="day">日视图</option>
          <option value="week">周视图</option>
        </Select>
        <Button aria-label="缩小时间轴" onClick={() => setZoom(Math.max(0.6, zoom - 0.2))}>
          <ZoomOut size={17} />
        </Button>
        <Button aria-label="放大时间轴" onClick={() => setZoom(Math.min(2, zoom + 0.2))}>
          <ZoomIn size={17} />
        </Button>
      </div>
      <div className="toolbar filters">
        <Select
          aria-label="时间轴展示"
          value={view}
          onChange={(e) => setView(e.target.value as TimelineView)}
        >
          {['featured', 'all', 'social', 'shared', 'personal', 'routine'].map((v, i) => (
            <option key={v} value={v}>
              {['精选事件', '全部事件', '社交互动', '共同活动', '重要个人事件', '日常状态'][i]}
            </option>
          ))}
        </Select>
        <Button onClick={() => setDate('')}>回到最新</Button>
        <Select aria-label="角色筛选" value={person} onChange={(e) => setPerson(e.target.value)}>
          <option value="">全部角色</option>
          {data?.chars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select aria-label="团体筛选" value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">全部团体</option>
          {data?.groups
            .filter((g) => g.worldIds.includes(worldId))
            .map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
        </Select>
        <Select aria-label="活动类型筛选" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">全部活动</option>
          {[
            ['sleep', '睡觉'],
            ['work', '工作学习'],
            ['meal', '吃饭'],
            ['rest', '休息'],
            ['out', '外出'],
            ['social', '共同活动'],
          ].map(([v, t]) => (
            <option key={v} value={v}>
              {t}
            </option>
          ))}
        </Select>
      </div>
      <div className="timeline-panel">
        <div className="section-title">
          <h3>
            <CalendarDays size={18} /> {world ? `${world.era ?? 'AD'} ${shownDate}` : shownDate}
          </h3>
          <span className="tag">{events.length} 个生活片段</span>
        </div>
        {events.length ? (
          <div
            className="life-log"
            style={{ '--timeline-spacing': `${24 * zoom}px` } as React.CSSProperties}
          >
            {events.slice(0, 400).map((e) => (
              <button
                className={`life-log-event type-${e.type}`}
                data-start={e.start}
                key={e.id}
                onClick={() => {
                  const scene = data?.scenes.find((s) => s.eventId === e.id);
                  if (scene) setScene(scene);
                  else setSelected(e);
                }}
              >
                <time>
                  {time(e.start)}
                  <small>
                    {scope === 'week' && world ? calendarDate(world, e.start) : time(e.end)}
                  </small>
                </time>
                <span className="event-dot" />
                <div>
                  <span className="event-place">{e.location}</span>
                  <h4>{e.description}</h4>
                  {data?.scenes.find((s) => s.eventId === e.id) && (
                    <span className="tag">
                      {data.scenes.find((s) => s.eventId === e.id)!.phases.length} 阶段 ·
                      查看线下对话 ↗
                    </span>
                  )}
                  <div className="avatar-stack">
                    {e.participants.map((id) => (
                      <Avatar key={id} character={data?.chars.find((c) => c.id === id)} size={28} />
                    ))}
                  </div>
                </div>
                <span className="event-duration">{Math.round((e.end - e.start) / 60000)} 分钟</span>
              </button>
            ))}
          </div>
        ) : (
          <Empty
            title="这一天，故事还没落笔"
            description="开始观察后，角色的真实活动会记录在这里。"
          />
        )}
        {events.length > 400 && (
          <p className="muted">当前显示前 400 个片段，请按角色或日期进一步筛选。</p>
        )}
      </div>
      {scene && <SceneDetail scene={scene} onClose={() => setScene(undefined)} />}
      {selected && (
        <Modal title="一个生活片段" onClose={() => setSelected(undefined)}>
          <p>{selected.description}</p>
          <p>
            {world ? formatWorldTime(world, selected.start) : time(selected.start)} —{' '}
            {time(selected.end)}
          </p>
          <p>地点：{selected.location}</p>
          <p>
            参与者：
            {selected.participants
              .map((id) => data?.chars.find((c) => c.id === id)?.name)
              .join('、')}
          </p>
          <p>手机可用程度：{Math.round(selected.phone * 100)}%</p>
          <Button
            onClick={async () => {
              const m = await db.messages.where('eventId').equals(selected.id).first();
              if (m) onConversation(m.conversationId);
              else {
                const c = await db.conversations
                  .where('worldId')
                  .equals(worldId)
                  .and((c) => selected.participants.every((id) => c.participants.includes(id)))
                  .first();
                if (c) onConversation(c.id);
              }
            }}
          >
            <MessageCircle size={16} />
            查看相关会话
          </Button>
        </Modal>
      )}
    </div>
  );
}
