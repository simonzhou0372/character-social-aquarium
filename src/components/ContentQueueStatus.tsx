import Dexie from 'dexie';
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { retryContent } from '../ai/content-queue';
import { Button, Modal, Status } from './ui';
export function ContentQueueStatus({ worldId }: { worldId: string }) {
  const pendingRanges = () =>
    ['pending', 'running', 'failed'].map((status) =>
      db.contentJobs
        .where('[worldId+status+at]')
        .between([worldId, status, Dexie.minKey], [worldId, status, Dexie.maxKey]),
    );
  const jobs = useLiveQuery(
    async () =>
      (await Promise.all(pendingRanges().map((r) => r.limit(50).toArray())))
        .flat()
        .sort((a, b) => a.at - b.at)
        .slice(0, 50),
    [worldId],
  );
  const count = useLiveQuery(
    async () =>
      (await Promise.all(pendingRanges().map((r) => r.count()))).reduce((a, b) => a + b, 0),
    [worldId],
  );
  const [open, setOpen] = useState(false),
    [error, setError] = useState('');
  if (!jobs?.length) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        {jobs.some((j) => j.status === 'running')
          ? 'AI 等待'
          : jobs.some((j) => j.status === 'failed')
            ? '生成待恢复'
            : '后台内容生成中'}{' '}
        · {count ?? jobs.length}
      </Button>
      {open && (
        <Modal title="生成任务状态" onClose={() => setOpen(false)}>
          <p>世界时钟和生活调度独立运行；内容按原事件时间归档。已通过的场景阶段不会丢失。</p>
          {jobs.slice(0, 50).map((j) => (
            <article className="panel" key={j.id}>
              <strong>
                {
                  { chat: '线上聊天', scene: '线下场景', life: '生活描述', major: '大型事件' }[
                    j.kind
                  ]
                }{' '}
                ·{' '}
                {j.status === 'running'
                  ? '正在等待AI'
                  : j.status === 'failed'
                    ? '等待重试'
                    : '排队中'}
              </strong>
              <p>{j.event.description}</p>
              {j.error && <Status error>{j.error}</Status>}
              {j.status === 'failed' && (
                <Button onClick={() => void retryContent(j.id).catch((e) => setError(String(e)))}>
                  重试此任务
                </Button>
              )}
            </article>
          ))}
          {(count ?? 0) > 50 && <p>显示前50项，其余任务仍保存于队列。</p>}
          {error && <Status error>{error}</Status>}
        </Modal>
      )}
    </>
  );
}
