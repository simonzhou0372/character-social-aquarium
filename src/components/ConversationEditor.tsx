import { useState } from 'react';
import type { Conversation } from '../core/types';
import { renameConversation } from '../data/titles';
import { AvatarUpload } from './AvatarUpload';
import { Modal, Button, Field, Input, Status } from './ui';
export function ConversationEditor({
  conversation: c,
  onClose,
}: {
  conversation: Conversation;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(c.name),
    [avatar, setAvatar] = useState(c.avatar ?? ''),
    [error, setError] = useState('');
  return (
    <Modal title="会话名称与图片" onClose={onClose}>
      <Field label="会话名称">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <p>{c.titleMode === 'custom' ? '用户自定义' : '自动生成'}</p>
      <AvatarUpload value={avatar} name={title} onChange={setAvatar} />
      <Button
        onClick={async () => {
          try {
            await renameConversation(c.id, title, avatar);
            onClose();
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        保存会话设置
      </Button>
      <Button
        onClick={async () => {
          try {
            await renameConversation(c.id, undefined, avatar);
            onClose();
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        恢复自动命名
      </Button>
      {error && <Status error>{error}</Status>}
    </Modal>
  );
}
