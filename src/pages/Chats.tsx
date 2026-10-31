import { sceneLinks } from '../data/chat-scenes';
import { ChatHistoryMenu } from '../components/ChatHistoryMenu';
import { ChatExport, isSelected, type ChatSelection } from '../components/ChatExport';
import { SceneDetail } from './Scenes';
import type { InPersonScene } from '../core/types';
import Dexie from 'dexie';
import { useChatHistory } from '../hooks/useChatHistory';
import { historyRange } from '../data/chat-history';
import { activeConversations } from '../core/adaptive-batching';
import { ConversationAvatar } from '../components/ConversationAvatar';
import type { Message } from '../core/types';
import { ensureNotes, saveNote, recordObserved } from '../data/chat';
import { GifLibrary } from '../components/GifLibrary';
import { GifImage } from '../components/GifImage';
import { MessageDetails } from '../components/MessageDetails';
import { CharacterEditor } from './Characters';
import { ConversationEditor } from '../components/ConversationEditor';
import { formatWorldClock, calendarDate } from '../core/calendar';
import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Search, Send, ChevronLeft, Users, Eye, UserRound, BookOpen, Plus } from 'lucide-react';
import { db } from '../data/db';
import { sendUserMessage, replyToUser, consolidateMemory } from '../ai/orchestrator';
import { createDirect } from '../core/engine';
import {
  Avatar,
  Button,
  Select,
  Input,
  Modal,
  Status,
  Empty,
  fmtTime,
  fmtDate,
} from '../components/ui';
export function Chats({
  worldId,
  selectedId,
  onSelect,
}: {
  worldId: string;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const data = useLiveQuery(
    async () => ({
      convs: await db.conversations.where('worldId').equals(worldId).reverse().sortBy('lastAt'),
      chars: await db.characters.toArray(),
      groups: await db.groups.toArray(),
      groupMembers: await db.groupMembers.where('worldId').equals(worldId).toArray(),
      previews: await Promise.all(
        (await db.conversations.where('worldId').equals(worldId).toArray()).map(async (c) => {
          const cursor = await db.cursors.get(`observer:${c.id}`);
          return {
            id: c.id,
            last: await historyRange(c.id).reverse().first(),
            unread: await db.messages
              .where('[conversationId+seq]')
              .between([c.id, cursor?.seq ?? 0], [c.id, Dexie.maxKey], false, false)
              .count(),
          };
        }),
      ),
      cursors: await db.cursors.toArray(),
      states: await db.states.where('worldId').equals(worldId).toArray(),
      members: await db.memberships.where('worldId').equals(worldId).toArray(),
      settings: await db.settings.get('app'),
      world: await db.worlds.get(worldId),
    }),
    [worldId],
  );
  const [gifOpen, setGifOpen] = useState(false),
    [reply, setReply] = useState<Message>(),
    [mentions, setMentions] = useState<NonNullable<Message['mentions']>>([]),
    [mentionQuery, setMentionQuery] = useState<string>(),
    [mentionStart, setMentionStart] = useState(0),
    [viewCharacter, setViewCharacter] = useState(''),
    [jumpId, setJumpId] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false),
    [selecting, setSelecting] = useState(false),
    [exporting, setExporting] = useState(false);
  const [selection, setSelection] = useState<ChatSelection>({
    ids: new Set(),
    excluded: new Set(),
  });
  const lastSelected = useRef<Message>();
  const [scene, setScene] = useState<InPersonScene>();
  const [editingConversation, setEditingConversation] = useState(false);
  const [holdReading, setHoldReading] = useState(false);
  const [search, setSearch] = useState(''),
    [text, setText] = useState(''),
    [identity, setIdentity] = useState('observer'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [retryable, setRetryable] = useState(false),
    [newChat, setNewChat] = useState(false),
    [pair, setPair] = useState(['', '']);
  const feed = useRef<HTMLDivElement>(null),
    initialCursor = useRef<number>(),
    convo = data?.convs.find((c) => c.id === selectedId),
    tz = data?.world?.timezone;
  const time = (at: number) => (data?.world ? formatWorldClock(data.world, at) : fmtTime(at, tz));
  const date = (at: number) =>
    data?.world ? `${data.world.era ?? 'AD'} ${calendarDate(data.world, at)}` : fmtDate(at, tz);
  const history = useChatHistory(selectedId, feed, holdReading);
  const messages = history.rows;
  const visible = messages;
  const [latestReadSeq, setLatestReadSeq] = useState<number>();
  useEffect(() => {
    setLatestReadSeq(undefined);
  }, [selectedId]);
  useEffect(() => {
    if (history.following && !holdReading && messages.length)
      setLatestReadSeq(messages.at(-1)!.seq);
  }, [history.following, holdReading, messages.at(-1)?.seq]);
  const newMessages = useLiveQuery(() => {
    const seq = latestReadSeq;
    return seq === undefined
      ? 0
      : db.messages
          .where('[conversationId+seq]')
          .between([selectedId, seq], [selectedId, Dexie.maxKey], false, false)
          .count();
  }, [selectedId, latestReadSeq]);
  const sceneLinkMode = data?.settings?.sceneLinkMode ?? 'all';
  const timelineScenes = useLiveQuery(async () => {
    if (!convo || !messages.length || convo.participants.length < 2) return [];
    return sceneLinks(
      convo,
      messages[0].simAt,
      messages.at(-1)!.simAt,
      0,
      160,
      false,
      db,
      sceneLinkMode,
    );
  }, [worldId, selectedId, messages[0]?.simAt, messages.at(-1)?.simAt, sceneLinkMode]);
  function toggleSelected(m: Message, range: boolean) {
    if (range && lastSelected.current) {
      const ordered = [m, lastSelected.current].sort(
        (a, b) => a.simAt - b.simAt || (a.id < b.id ? -1 : 1),
      );
      setSelection({
        ids: new Set(),
        excluded: new Set(),
        range: {
          from: ordered[0].simAt,
          to: ordered[1].simAt,
          fromId: ordered[0].id,
          toId: ordered[1].id,
        },
      });
    } else
      setSelection((s) => {
        const ids = new Set(s.ids),
          excluded = new Set(s.excluded);
        if (isSelected(m, s)) {
          ids.delete(m.id);
          excluded.add(m.id);
        } else {
          ids.add(m.id);
          excluded.delete(m.id);
        }
        return { ...s, ids, excluded };
      });
    lastSelected.current = m;
  }
  useEffect(() => {
    if (convo) activeConversations.set(worldId, convo.id);
    return () => {
      activeConversations.delete(worldId);
    };
  }, [worldId, convo?.id]);
  useEffect(() => {
    if (worldId) void ensureNotes(worldId).catch((e) => setError(String(e)));
  }, [worldId]);
  useEffect(() => {
    setSelection({ ids: new Set(), excluded: new Set() });
    setSelecting(false);
    setExporting(false);
    setScene(undefined);
    lastSelected.current = undefined;
    initialCursor.current = undefined;

    setReply(undefined);
    setMentions([]);
    setMentionQuery(undefined);

    setError('');
    setRetryable(false);
    setText('');
    setHoldReading(false);
    setIdentity(convo?.kind === 'notes' ? 'user' : (convo?.controlledId ?? 'observer'));
  }, [selectedId]);
  useEffect(() => {
    if (!data || !convo) return;
    if (initialCursor.current === undefined)
      initialCursor.current = data.cursors.find((c) => c.id === `observer:${selectedId}`)?.seq ?? 0;
  }, [selectedId, messages.length, data?.cursors.length]);
  async function markRead() {
    if (!convo || document.hidden || !feed.current || document.querySelector('[aria-modal="true"]'))
      return;
    const rect = feed.current.getBoundingClientRect();
    const ids = [...feed.current.querySelectorAll<HTMLElement>('[data-message-id]')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > rect.top + 10 && r.top < rect.bottom - 10;
      })
      .map((el) => el.dataset.messageId!);
    if (ids.length) await recordObserved(convo.id, ids);
  }
  useEffect(() => {
    const timer = setTimeout(() => void markRead(), 180);
    return () => clearTimeout(timer);
  }, [
    selectedId,
    historyOpen,
    exporting,
    scene?.id,
    history.virtual.range?.startIndex,
    history.virtual.range?.endIndex,
    visible[0]?.id,
    visible.at(-1)?.id,
  ]);
  async function jump(id: string) {
    if (!(await history.jump(id))) setError('原消息已删除或无法访问');
    else setJumpId(id);
  }
  async function firstUnread() {
    const m = await db.messages
      .where('[conversationId+seq]')
      .between([selectedId, initialCursor.current ?? 0], [selectedId, Dexie.maxKey], false, false)
      .first();
    if (m) void jump(m.id);
  }
  async function sendGif(id: string) {
    if (!convo || identity === 'observer') return;
    try {
      await sendUserMessage(convo.id, '[GIF]', identity, db, {
        gifAssetId: id,
        replyToMessageId: reply?.id,
      });
      setGifOpen(false);
      setReply(undefined);
      history.latest();
    } catch (e) {
      setError(String(e));
    }
  }
  async function switchIdentity(id: string) {
    setIdentity(id);
    setText('');
    setReply(undefined);
    setMentions([]);
    setMentionQuery(undefined);
    if (convo)
      await db.conversations.update(convo.id, {
        controlledId: id === 'observer' || id === 'user' ? undefined : id,
      });
  }
  async function send() {
    if (!convo || busy || !text.trim() || identity === 'observer') return;
    setBusy(true);
    setError('');
    setRetryable(false);
    let sent = false;
    try {
      if (convo.kind === 'notes') await saveNote(convo.id, text, reply?.id);
      else
        await sendUserMessage(convo.id, text, identity, db, {
          replyToMessageId: reply?.id,
          mentions,
        });
      setReply(undefined);
      setMentions([]);
      setMentionQuery(undefined);

      sent = true;
      setHoldReading(false);
      setText('');
      history.latest();
      if (convo.kind !== 'notes') await replyToUser(convo.id);
    } catch (e) {
      setRetryable(sent);
      setError(e instanceof Error ? e.message : '发送失败');
    } finally {
      setBusy(false);
    }
  }
  async function retryReply() {
    if (!convo || busy) return;
    setBusy(true);
    setError('');
    try {
      const latest = await historyRange(convo.id).reverse().first();
      if (latest?.source !== 'user') {
        setRetryable(false);
        setError('会话已经有了新消息，可以继续观察。');
        return;
      }
      if (convo.kind !== 'notes') await replyToUser(convo.id);
      setRetryable(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : '重试失败');
    } finally {
      setBusy(false);
    }
  }
  const unread = (id: string) => data?.previews.find((p) => p.id === id)?.unread ?? 0;
  const roleCharacter = data?.chars.find((c) => c.id === identity);
  const roleAccent =
    roleCharacter?.color ??
    (identity === 'user' ? '#d9ef69' : identity === 'observer' ? '#8ee8d4' : '#d9ef69');
  return (
    <div
      className={`chat-layout ${convo ? 'has-chat' : ''}`}
      data-identity={identity}
      style={{ '--role-accent': roleAccent } as React.CSSProperties}
    >
      <aside className="conversation-list">
        <div className="chat-list-title">
          <div>
            <span className="eyebrow">MESSAGES</span>
            <h2>正在发生的对话</h2>
          </div>
          <button className="icon-button" aria-label="新建私聊" onClick={() => setNewChat(true)}>
            <Plus size={20} />
          </button>
        </div>
        <div className="search-box">
          <Search size={16} />
          <input
            aria-label="搜索会话"
            placeholder="搜索会话…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="list-filter">
          <span>全部会话</span>
          <b>{data?.convs.length ?? 0}</b>
        </div>
        {data?.convs
          .filter(
            (c) =>
              (!c.groupId ||
                data.groups.some(
                  (g) => g.id === c.groupId && !g.deletedAt && g.entityMode !== 'background',
                )) &&
              (c.kind === 'notes' ||
                c.participants.every((id) =>
                  data.chars.some(
                    (x) => x.id === id && !x.deletedAt && x.entityMode !== 'background',
                  ),
                )),
          )
          .filter((c) => c.name.includes(search))
          .sort((a, b) => Number(b.kind === 'notes') - Number(a.kind === 'notes'))
          .map((c) => {
            const last = data.previews.find((p) => p.id === c.id)?.last;
            const count = unread(c.id);
            return (
              <button
                key={c.id}
                className={`conversation-item ${selectedId === c.id ? 'active' : ''}`}
                onClick={() => onSelect(c.id)}
              >
                <ConversationAvatar
                  conversation={c}
                  characters={data.chars}
                  user={{ name: data.settings?.nickname, avatar: data.settings?.userAvatar }}
                />
                <div>
                  <div>
                    <strong>{c.name}</strong>
                    <time>
                      {last ? (c.kind === 'notes' ? fmtTime(last.realAt) : time(last.simAt)) : ''}
                    </time>
                  </div>
                  <p>
                    {(last
                      ? `${data.groupMembers.find((x) => x.groupId === c.groupId && x.characterId === last.senderId)?.nickname || data.chars.find((x) => x.id === last.senderId)?.name || data.settings?.nickname || '用户'}：${last.gifAssetId ? '[GIF]' : last.text}`
                      : undefined) ??
                      (c.kind === 'notes'
                        ? '给自己写点备注，仅本地保存，不发给 AI。'
                        : '还没有消息，等一次自然的开场。')}
                  </p>
                </div>
                {count > 0 && <span className="unread-count">{count > 99 ? '99+' : count}</span>}
              </button>
            );
          })}
        <div className="chat-list-note">
          <Eye size={16} />
          <span>不说话，也能看见故事发生。</span>
        </div>
      </aside>
      <section className="chat-main">
        {convo ? (
          <>
            <header className="chat-header" key={convo.id}>
              <button
                className="icon-button chat-back"
                aria-label="返回会话列表"
                onClick={() => onSelect('')}
              >
                <ChevronLeft size={20} />
              </button>
              <ConversationAvatar
                conversation={convo}
                characters={data?.chars ?? []}
                user={{ name: data?.settings?.nickname, avatar: data?.settings?.userAvatar }}
                size={40}
              />
              <div>
                <h2>{convo.name}</h2>
                <Button onClick={() => setEditingConversation(true)}>编辑名称 / 图片</Button>
                <span>
                  {convo.kind === 'notes'
                    ? '只属于你的备注 · 使用现实时间，不调用 AI'
                    : `${convo.participants.length} 位角色 · ${convo.kind === 'group' ? '群聊' : '私聊'}`}
                </span>
              </div>
              <Button
                variant="ghost"
                aria-label="整理长期记忆"
                disabled={convo.kind === 'notes'}
                onClick={async () => {
                  try {
                    await consolidateMemory(convo.id);
                    setError('记忆已整理，只有本会话角色能够检索。');
                  } catch (e) {
                    setError(e instanceof Error ? e.message : '整理失败');
                  }
                }}
              >
                <BookOpen size={18} />
              </Button>
            </header>
            <div className="chat-tools">
              <Button
                onClick={() => {
                  setHoldReading(!holdReading);
                  if (holdReading) history.latest();
                }}
              >
                {holdReading ? '继续跟随新消息' : '暂停跟随新消息'}
              </Button>
              <Button onClick={() => setHistoryOpen(true)}>历史导航</Button>
              <Button onClick={() => setSelecting(!selecting)}>选择消息</Button>
              {selecting && (
                <>
                  <Button onClick={() => setExporting(true)}>导出选中消息</Button>
                  <Button onClick={() => setSelection({ ids: new Set(), excluded: new Set() })}>
                    取消全选
                  </Button>
                </>
              )}
              <Button onClick={firstUnread}>跳转到第一条未读</Button>
              <Button
                onClick={() => {
                  setHoldReading(false);
                  history.latest();
                }}
              >
                回到最新消息
              </Button>
              <span className="observer-banner" title="观察模式下，你正悄悄看着他们的日常">
                <Eye size={15} />
                <span>
                  {convo.kind === 'notes'
                    ? '我的备忘 · 不进入角色记忆，不发送到模型'
                    : identity === 'observer'
                      ? '观察模式'
                      : identity === 'user'
                        ? `以「${data?.settings?.nickname}」参与`
                        : `正在扮演「${data?.chars.find((c) => c.id === identity)?.name}」，AI 已让出该角色`}
                </span>
              </span>
            </div>
            <div
              className="message-feed"
              ref={feed}
              onScroll={() => {
                const f = feed.current;
                if (!f) return;
                void history.onScroll();
              }}
            >
              <div
                style={{
                  height: history.virtual.getTotalSize(),
                  position: 'relative',
                  width: '100%',
                }}
              >
                {history.virtual.getVirtualItems().map((item) => {
                  const i = item.index,
                    m = visible[i];
                  const c = data?.chars.find((c) => c.id === m.senderId),
                    isUser =
                      identity === 'observer' ? m.senderId === 'user' : m.senderId === identity,
                    prev = visible[i - 1],
                    day = convo.kind === 'notes' ? fmtDate(m.realAt) : date(m.simAt),
                    newDay =
                      !prev ||
                      (convo.kind === 'notes' ? fmtDate(prev.realAt) : date(prev.simAt)) !== day,
                    cursor = initialCursor.current ?? 0,
                    readBy =
                      data?.cursors.filter(
                        (x) =>
                          x.kind === 'character' &&
                          x.conversationId === selectedId &&
                          x.readerId !== m.senderId &&
                          x.seq >= m.seq,
                      ).length ?? 0;
                  return (
                    <div
                      key={m.id}
                      data-index={i}
                      ref={history.virtual.measureElement}
                      style={{
                        position: 'absolute',
                        width: '100%',
                        top: 0,
                        transform: `translateY(${item.start}px)`,
                      }}
                    >
                      {timelineScenes
                        ?.filter((s) => s.start <= m.simAt && (!prev || s.start > prev.simAt))
                        .map((s) => {
                          const present = s.participants
                            .filter((id) => convo.participants.includes(id))
                            .map(
                              (id) =>
                                data?.chars.find((c) => c.id === id)?.name ??
                                data?.settings?.nickname,
                            )
                            .filter(Boolean)
                            .join('、');
                          return (
                            <button
                              className="scene-link-row"
                              key={s.eventId}
                              onClick={() => void db.scenes.get(s.id).then(setScene)}
                              title={`${time(s.start)} · ${s.location}`}
                            >
                              <span className="scene-link-dot" aria-hidden="true" />
                              <time>{time(s.start)}</time>
                              <strong>{present || '他们'}在线下互动：</strong>
                              <span>[{s.title}]</span>
                              <em>{s.location}</em>
                              <b aria-hidden="true">查看 ↗</b>
                            </button>
                          );
                        })}
                      {selecting && (
                        <label>
                          <input
                            type="checkbox"
                            aria-label={`选择消息 ${m.id}`}
                            checked={isSelected(m, selection)}
                            onChange={(e) =>
                              toggleSelected(m, (e.nativeEvent as MouseEvent).shiftKey)
                            }
                          />
                          选择（Shift 连选）
                        </label>
                      )}
                      {newDay && <div className="date-divider">{day}</div>}
                      {m.seq === cursor + 1 && (
                        <div className="unread-divider">以下是尚未阅读的消息</div>
                      )}
                      <div
                        data-message-id={m.id}
                        data-seq={m.seq}
                        data-unread={m.seq > cursor || undefined}
                        data-participant={m.senderId}
                        className={`message ${isUser ? 'self' : ''} ${jumpId === m.id ? 'highlight' : ''} ${m.seq === cursor + 1 ? 'first-unread' : ''}`}
                        style={
                          {
                            '--speaker-color': c?.color ?? '#d9ef69',
                            animation: Date.now() - m.realAt < 1500 ? undefined : 'none',
                          } as React.CSSProperties
                        }
                      >
                        <Avatar
                          character={
                            c ?? {
                              name: data?.settings?.nickname,
                              avatar: data?.settings?.userAvatar,
                              color: '#d9ef69',
                            }
                          }
                          size={36}
                        />
                        <div className="message-content">
                          <div className="message-label">
                            <strong>{c?.name ?? data?.settings?.nickname}</strong>
                            <time>
                              {convo.kind === 'notes' ? fmtTime(m.realAt) : time(m.simAt)}
                            </time>
                            {m.source === 'demo' && <span className="demo-label">演示</span>}
                            {m.backfilled && <span>补全记录</span>}
                            {m.source === 'user' && <span>用户控制</span>}
                          </div>
                          {m.replyToMessageId && (
                            <div
                              className="quoted-message"
                              onClick={() => jump(m.replyToMessageId!)}
                            >
                              {(() => {
                                const original = messages.find((o) => o.id === m.replyToMessageId);
                                return original
                                  ? `${data?.chars.find((c) => c.id === original.senderId)?.name ?? data?.settings?.nickname}：${original.text.slice(0, 100)}`
                                  : '查看引用消息';
                              })()}
                            </div>
                          )}
                          <div className="message-bubble">
                            {m.gifAssetId ? (
                              <GifImage
                                assetId={m.gifAssetId}
                                autoplay={data?.settings?.gifAutoplay}
                              />
                            ) : (
                              <>
                                {(() => {
                                  const nodes: React.ReactNode[] = [];
                                  let end = 0;
                                  for (const mention of [...(m.mentions ?? [])].sort(
                                    (a, b) => a.start - b.start,
                                  )) {
                                    if (
                                      mention.start < end ||
                                      m.text.slice(mention.start, mention.end) !== mention.label
                                    )
                                      continue;
                                    nodes.push(
                                      m.text.slice(end, mention.start),
                                      <button
                                        className="mention"
                                        key={mention.start}
                                        onClick={() => setViewCharacter(mention.characterId)}
                                      >
                                        {' '}
                                        @
                                        {data?.chars.find((c) => c.id === mention.characterId)
                                          ?.name ?? mention.label}{' '}
                                      </button>,
                                    );
                                    end = mention.end;
                                  }
                                  nodes.push(m.text.slice(end));
                                  return nodes;
                                })()}
                              </>
                            )}
                          </div>
                          <MessageDetails
                            message={m}
                            identity={identity}
                            onReply={() => setReply(m)}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {!messages.length && (
                <Empty
                  title="对话还没有开始"
                  description="让世界运行一会儿，或者选择身份先说一句。"
                />
              )}
              {busy && (
                <div className="typing-indicator" aria-live="polite">
                  <span className="typing-orbit" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>
                    <strong>正在等待一个回复</strong>
                    <small>角色会在合适的时候接话，不会假装已经发送</small>
                  </span>
                </div>
              )}
            </div>
            {(!history.following || holdReading) && !!newMessages && (
              <Button
                className="chat-new-messages"
                onClick={() => {
                  setHoldReading(false);
                  history.latest();
                }}
              >
                有 {newMessages} 条新消息 · 回到最新
              </Button>
            )}
            {error && (
              <div className="chat-error">
                <Status error>{error}</Status>
                {retryable && (
                  <Button disabled={busy} onClick={retryReply}>
                    {busy ? '正在恢复回复…' : '重试回复（不重发你的消息）'}
                  </Button>
                )}
              </div>
            )}
            <footer className="composer">
              {reply && (
                <div className="quoted-message">
                  回复{' '}
                  {data?.chars.find((c) => c.id === reply.senderId)?.name ??
                    data?.settings?.nickname}
                  ：{reply.text.slice(0, 100)}
                  <Button onClick={() => setReply(undefined)}>取消回复</Button>
                </div>
              )}
              {mentionQuery !== undefined && convo.kind === 'group' && (
                <div className="check-list">
                  {data?.chars
                    .filter(
                      (c) =>
                        convo.participants.includes(c.id) &&
                        c.name.toLowerCase().includes(mentionQuery.toLowerCase()),
                    )
                    .map((c) => (
                      <button
                        key={c.id}
                        onClick={() => {
                          const label = '@' + c.name;
                          setText(text.slice(0, mentionStart) + label + ' ');
                          setMentions((ms) => [
                            ...ms.filter((m) => m.end <= mentionStart),
                            {
                              characterId: c.id,
                              start: mentionStart,
                              end: mentionStart + label.length,
                              label,
                            },
                          ]);
                          setMentionQuery(undefined);
                        }}
                      >
                        <Avatar character={c} size={24} />
                        {c.name}
                      </button>
                    ))}
                </div>
              )}
              <div className="composer-identity">
                <div className="chat-tools composer-inline-tools">
                  <Button disabled={convo.kind === 'notes'} onClick={() => setGifOpen(true)}>
                    GIF 表情
                  </Button>
                  {convo.kind === 'group' && (
                    <Button
                      disabled={identity === 'observer'}
                      onClick={() => {
                        setMentionStart(text.length);
                        setText(text + '@');
                        setMentionQuery('');
                      }}
                    >
                      @ 提及成员
                    </Button>
                  )}
                </div>
                <UserRound size={16} />
                <Select
                  aria-label="聊天身份"
                  disabled={convo.kind === 'notes'}
                  value={identity}
                  onChange={(e) => void switchIdentity(e.target.value)}
                >
                  <option value="observer">只观察，不参与</option>
                  <option value="user">作为 {data?.settings?.nickname} 参与</option>
                  {convo.participants
                    .filter((id) => id !== 'user')
                    .map((id) => (
                      <option key={id} value={id}>
                        扮演 {data?.chars.find((c) => c.id === id)?.name}
                      </option>
                    ))}
                </Select>
                <span>历史消息的身份不会改变</span>
              </div>
              <div className="composer-input">
                <textarea
                  aria-label="消息内容"
                  placeholder={
                    identity === 'observer' ? '选择参与身份，或继续安静地观察…' : '说点什么吧…'
                  }
                  value={text}
                  maxLength={2000}
                  disabled={identity === 'observer'}
                  onChange={(e) => {
                    setText(e.target.value);
                    const match = e.target.value
                      .slice(0, e.target.selectionStart)
                      .match(/@([^@\n]*)$/);
                    if (match && convo.kind === 'group') {
                      setMentionStart(e.target.selectionStart - match[0].length);
                      setMentionQuery(match[1]);
                    } else setMentionQuery(undefined);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <Button
                  variant="primary"
                  onClick={send}
                  disabled={busy || identity === 'observer' || !text.trim()}
                  aria-label="发送消息"
                >
                  <Send size={18} />
                </Button>
              </div>
              <small>Enter 发送 · Shift + Enter 换行 · 角色忙碌时可能晚些回复</small>
            </footer>
          </>
        ) : (
          <Empty
            title="挑一段日常，安静地看一会儿"
            description="私聊与群聊会记录真实的发送者、模拟时间和角色阅读状态。"
          />
        )}
      </section>
      <aside className="chat-context">
        <span className="eyebrow">IN THIS CONVERSATION</span>
        <h3>他们此刻的生活</h3>
        {convo?.participants.map((id) => {
          const c = data?.chars.find((c) => c.id === id),
            s = data?.states.find((s) => s.characterId === id);
          return (
            <div className="context-person" key={id}>
              <Avatar character={c} size={46} />
              <div>
                <strong>{c?.name}</strong>
                <span className="state-line">
                  <i className={s?.phone === 0 ? 'sleep' : s && s.phone < 0.3 ? 'busy' : ''} />
                  {s?.activity ?? '尚未开始模拟'}
                </span>
                <small>{s?.location ?? '等待生活落笔'}</small>
              </div>
            </div>
          );
        })}
        <div className="context-note">
          <span>OBSERVATION NOTE</span>
          <p>已读，不一定意味着回复。角色的生活不会因为聊天而停下。</p>
        </div>
      </aside>
      {scene && <SceneDetail key={scene.id} scene={scene} onClose={() => setScene(undefined)} />}
      {historyOpen && convo && data?.world && (
        <ChatHistoryMenu
          conversation={convo}
          world={data.world}
          jump={(id) => void jump(id)}
          latest={history.latest}
          onClose={() => setHistoryOpen(false)}
          select={(s) => {
            setSelection(s);
            setSelecting(true);
          }}
        />
      )}
      {exporting && convo && (
        <ChatExport
          key={convo.id}
          conversation={convo}
          selection={selection}
          onClose={() => setExporting(false)}
        />
      )}
      {viewCharacter && data?.chars.find((c) => c.id === viewCharacter) && (
        <CharacterEditor
          character={data.chars.find((c) => c.id === viewCharacter)}
          worldId={worldId}
          onClose={() => setViewCharacter('')}
        />
      )}
      {gifOpen && convo && (
        <GifLibrary
          conversation={convo}
          identity={identity}
          onSend={(id) => void sendGif(id)}
          onClose={() => setGifOpen(false)}
        />
      )}
      {editingConversation && convo && (
        <ConversationEditor conversation={convo} onClose={() => setEditingConversation(false)} />
      )}
      {newChat && (
        <Modal title="打开一扇双人窗口" onClose={() => setNewChat(false)}>
          {[0, 1].map((i) => (
            <Select
              key={i}
              aria-label={`私聊角色${i + 1}`}
              value={pair[i]}
              onChange={(e) => setPair(pair.map((x, j) => (i === j ? e.target.value : x)))}
            >
              <option value="">选择角色</option>
              {data?.chars
                .filter(
                  (c) =>
                    !c.deletedAt &&
                    c.entityMode !== 'background' &&
                    data.members.some((m) => m.characterId === c.id),
                )
                .map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name}
                  </option>
                ))}
            </Select>
          ))}
          <Button
            variant="primary"
            disabled={!pair[0] || !pair[1] || pair[0] === pair[1]}
            onClick={async () => {
              try {
                onSelect(await createDirect(worldId, pair[0], pair[1]));
                setNewChat(false);
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            开始旁观
          </Button>
        </Modal>
      )}
    </div>
  );
}
