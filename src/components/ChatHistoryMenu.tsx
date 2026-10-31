import { sceneLinks } from '../data/chat-scenes';
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import Dexie from 'dexie';
import { db } from '../data/db';
import { historyRange, messageAt } from '../data/chat-history';
import { calendarTick, worldTime } from '../core/calendar';
import type { Conversation, World } from '../core/types';
import { WorldDateEditor } from './WorldDateEditor';
import { Button, Modal } from './ui';
import type { ChatSelection } from './ChatExport';
export function ChatHistoryMenu({
  conversation: c,
  world,
  jump,
  latest,
  onClose,
  select,
}: {
  conversation: Conversation;
  world: World;
  jump: (id: string) => void;
  latest: () => void;
  onClose: () => void;
  select: (s: ChatSelection) => void;
}) {
  const [from, setFrom] = useState(worldTime(world, c.lastAt || c.createdAt)),
    [to, setTo] = useState(from),
    [notice, setNotice] = useState('');
  const [offset, setOffset] = useState(0);
  const events = useLiveQuery(
    async () => ({
      scenes: await sceneLinks(c, -Infinity, Infinity, offset, 30, true),
      major: await db.majorEvents
        .where('worldId')
        .equals(world.id)
        .reverse()
        .offset(offset)
        .limit(30)
        .toArray(),
    }),
    [world.id, c.id, offset],
  );
  async function at(t: number) {
    const m = await messageAt(c.id, t);
    if (m) {
      jump(m.id);
      setNotice(m.simAt === t ? '已定位' : '该时间没有消息，已定位邻近消息');
    } else setNotice('此会话尚无消息');
  }
  return (
    <Modal title="聊天历史导航与选择" onClose={onClose}>
      <p>{world.era ?? 'AD'} · 世界历法</p>
      <WorldDateEditor value={from} onChange={setFrom} label="开始日期" />
      <WorldDateEditor value={to} onChange={setTo} label="结束日期（含该分钟）" />
      <div className="chat-tools">
        <Button
          onClick={() => {
            try {
              void at(calendarTick(world, from));
            } catch (e) {
              setNotice(String(e));
            }
          }}
        >
          按日期跳转
        </Button>
        <Button
          onClick={async () => {
            const m = await historyRange(c.id).first();
            if (m) jump(m.id);
          }}
        >
          回到最顶
        </Button>
        <Button onClick={latest}>回到最新</Button>
        <Button
          onClick={() => {
            try {
              const start = calendarTick(world, from),
                end = calendarTick(world, to) + 59999;
              if (end < start) throw new Error('结束日期早于开始日期');
              select({ ids: new Set(), excluded: new Set(), range: { from: start, to: end } });
              setNotice('已选择日期范围，包含未加载的历史消息');
            } catch (e) {
              setNotice(String(e));
            }
          }}
        >
          选择日期范围 / 全选筛选结果
        </Button>
        <Button
          onClick={() =>
            select({
              ids: new Set(),
              excluded: new Set(),
              range: { from: -Infinity, to: Infinity },
            })
          }
        >
          选择全部历史
        </Button>
      </div>
      <p role="status">{notice}</p>
      <h3>线下故事</h3>
      {events?.scenes.map((s) => (
        <Button key={s.id} onClick={() => void at(s.start)}>
          {s.title}
        </Button>
      ))}
      <h3>重大事件</h3>
      {events?.major.map((e) => (
        <Button key={e.id} onClick={() => void at(e.timestamp)}>
          {e.title}
        </Button>
      ))}
      <div>
        <Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 30))}>
          上一页事件
        </Button>
        <Button onClick={() => setOffset(offset + 30)}>下一页事件</Button>
      </div>
    </Modal>
  );
}
