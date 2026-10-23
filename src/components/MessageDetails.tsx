import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { toggleReaction } from '../data/chat';
import type { Message } from '../core/types';
import { Button, Modal, Avatar, Status } from './ui';
import { formatWorldTime } from '../core/calendar';
import { ReactionPicker } from './ReactionPicker';
export function MessageDetails({
  message: m,
  identity,
  onReply,
}: {
  message: Message;
  identity: string;
  onReply: () => void;
}) {
  const data = useLiveQuery(
    async () => ({
      reactions: await db.reactions.where('messageId').equals(m.id).toArray(),
      reads: await db.readStates.where('messageId').equals(m.id).toArray(),
      cursors: await db.cursors.where('conversationId').equals(m.conversationId).toArray(),
      conversation: await db.conversations.get(m.conversationId),
      chars: await db.characters.toArray(),
      settings: await db.settings.get('app'),
    }),
    [m.id],
  );
  const [open, setOpen] = useState<'reads' | 'reactions'>(),
    [emojiOpen, setEmojiOpen] = useState(false),
    [reacting, setReacting] = useState(false),
    [error, setError] = useState('');
  const world = useLiveQuery(
    () => (data?.conversation ? db.worlds.get(data.conversation.worldId) : undefined),
    [data?.conversation?.worldId],
  );
  const name = (id: string) =>
    id === 'user'
      ? data?.settings?.nickname
      : (data?.chars.find((c) => c.id === id)?.name ?? '已移除成员');
  const reactions = [...new Set(data?.reactions.map((r) => r.emoji))];
  const readers = data?.conversation?.participants.filter((id) => id !== m.senderId) ?? [];
  const read = (id: string) =>
    m.simAt < (data?.conversation?.participantJoinedAt?.[id] ?? 0)
      ? undefined
      : (data?.reads.find((r) => r.readerId === id) ??
        data?.cursors.find((r) => r.kind === 'character' && r.readerId === id && r.seq >= m.seq));
  const count = readers.filter(read).length;
  return (
    <div className="chat-tools message-actions">
      <Button className="message-action" onClick={onReply}>
        回复
      </Button>
      <Button
        className="message-action"
        disabled={identity === 'observer'}
        aria-expanded={emojiOpen}
        onClick={() => setEmojiOpen(!emojiOpen)}
      >
        回应
      </Button>
      <button className="text-button read-receipt" onClick={() => setOpen('reads')}>
        {count ? `${count} 人已读` : '尚未被角色阅读'} · 详情
      </button>
      {reactions.map((e) => (
        <button className="reaction" key={e} onClick={() => setOpen('reactions')}>
          {e} {data?.reactions.filter((r) => r.emoji === e).length}
        </button>
      ))}
      {emojiOpen && (
        <ReactionPicker
          busy={reacting}
          onClose={() => setEmojiOpen(false)}
          onSelect={async (emoji) => {
            if (reacting) return;
            setReacting(true);
            setError('');
            try {
              await toggleReaction(m.id, identity, emoji);
              setEmojiOpen(false);
            } catch (e) {
              setError(String(e));
            } finally {
              setReacting(false);
            }
          }}
        />
      )}
      {error && <Status error>{error}</Status>}
      {open && (
        <Modal
          title={open === 'reads' ? '消息阅读详情' : 'Emoji 回应者'}
          onClose={() => setOpen(undefined)}
        >
          {open === 'reactions' ? (
            data?.reactions.map((r) => (
              <p key={r.id}>
                <Avatar
                  character={
                    data?.chars.find((c) => c.id === r.actorId) ?? {
                      name: data?.settings?.nickname,
                      avatar: data?.settings?.userAvatar,
                    }
                  }
                  size={28}
                />
                {name(r.actorId)} {r.emoji}{' '}
                <Button
                  disabled={r.actorId !== identity}
                  onClick={() => void toggleReaction(m.id, identity, r.emoji)}
                >
                  取消回应
                </Button>
              </p>
            ))
          ) : (
            <>
              <p>观察者阅读不会改变虚拟角色已读状态。</p>
              {readers.map((id) => {
                const r = read(id);
                const at = r && ('readAt' in r ? r.readAt : r.at);
                return (
                  <p key={id}>
                    <Avatar character={data?.chars.find((c) => c.id === id)} size={28} />
                    {name(id)} ·{' '}
                    {m.simAt < (data?.conversation?.participantJoinedAt?.[id] ?? 0)
                      ? '加入前消息'
                      : r
                        ? '已读'
                        : '未读'}{' '}
                    {at && world ? formatWorldTime(world, at) : ''}
                    {r && !('readAt' in r) ? '（历史游标记录）' : ''}
                  </p>
                );
              })}
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
