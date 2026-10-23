import { useState } from 'react';
import { reactionEmojiGroups } from '../core/reaction-emojis';

export function ReactionPicker({
  onSelect,
  onClose,
  busy,
}: {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [category, setCategory] = useState(0);
  return (
    <div
      className="reaction-picker"
      role="group"
      aria-label="选择回应表情"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="reaction-picker-heading">
        <strong>选择表情</strong>
        <button type="button" className="text-button" onClick={onClose}>
          收起
        </button>
      </div>
      <div className="reaction-categories" role="group" aria-label="表情分类">
        {reactionEmojiGroups.map((group, index) => (
          <button
            type="button"
            key={group.name}
            aria-pressed={category === index}
            onClick={() => setCategory(index)}
          >
            {group.name}
          </button>
        ))}
      </div>
      <div className="reaction-emoji-grid" aria-busy={busy}>
        {reactionEmojiGroups[category].emojis.map((emoji) => (
          <button
            type="button"
            className="reaction-emoji"
            key={emoji}
            aria-label={emoji}
            disabled={busy}
            onClick={() => onSelect(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
