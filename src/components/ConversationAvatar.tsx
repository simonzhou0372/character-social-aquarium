import type { Character, Conversation } from '../core/types';
import { Avatar } from './ui';
/** Derived at render time: member uploads and membership changes need no stored thumbnail. */
export function ConversationAvatar({
  conversation,
  characters,
  user,
  size = 46,
}: {
  conversation: Conversation;
  characters: Character[];
  user?: { name?: string; avatar?: string };
  size?: number;
}) {
  if (conversation.avatar)
    return (
      <Avatar character={{ name: conversation.name, avatar: conversation.avatar }} size={size} />
    );
  if (conversation.kind === 'notes') return <Avatar character={user} size={size} />;
  const ids = [...new Set(conversation.participants)].slice(
    0,
    conversation.kind === 'direct' ? 2 : 9,
  );
  const columns = ids.length > 4 ? 3 : 2;
  return (
    <span
      className={`conversation-avatar ${conversation.kind}`}
      role="img"
      aria-label={`${conversation.name} · ${conversation.kind === 'direct' ? '双方头像' : '成员组合头像'}`}
      style={{ width: size, height: size, gridTemplateColumns: `repeat(${columns}, 1fr)` }}
    >
      {ids.map((id) => (
        <Avatar
          key={id}
          character={id === 'user' ? user : characters.find((c) => c.id === id)}
          size={
            conversation.kind === 'direct'
              ? Math.round(size * 0.65)
              : Math.floor((size - 6) / columns)
          }
        />
      ))}
      {!ids.length && <Avatar character={{ name: conversation.name }} size={size - 4} />}
    </span>
  );
}
