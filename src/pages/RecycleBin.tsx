import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { purgeEntity, recycleEntity, recycleNames, type RecycleKind } from '../data/recycle';
import { Button, Confirm, Empty, Status } from '../components/ui';
export function RecycleBin() {
  const rows = useLiveQuery(
    async () =>
      (
        await Promise.all(
          (['worlds', 'groups', 'characters'] as const).map(async (kind) =>
            (
              await db
                .table(kind)
                .filter((r) => !!r.deletedAt)
                .toArray()
            ).map((r) => ({
              kind,
              id: r.id as string,
              name: r.name as string,
              at: r.deletedAt as number,
            })),
          ),
        )
      )
        .flat()
        .sort((a, b) => b.at - a.at),
    [],
  );
  const [target, setTarget] = useState<{ kind: RecycleKind; id: string; name: string }>(),
    [second, setSecond] = useState(false),
    [error, setError] = useState('');
  return (
    <div className="page">
      <div className="page-heading">
        <span className="eyebrow">RECYCLE BIN</span>
        <h1>回收站</h1>
        <p>移入的世界、团体和角色保留设定与历史。恢复的世界保持暂停，请检查后继续。</p>
      </div>
      {error && <Status error>{error}</Status>}
      {!rows?.length && (
        <Empty title="回收站是空的" description="删除的世界、团体和角色会先来到这里。" />
      )}
      {rows?.map((r) => (
        <article className="panel" key={r.kind + r.id}>
          <span className="tag">{recycleNames[r.kind]}</span>
          <h2>{r.name}</h2>
          <p>{new Date(r.at).toLocaleString('zh-CN')} 移入</p>
          <div className="toolbar">
            <Button
              onClick={async () => {
                try {
                  await recycleEntity(r.kind, r.id, true);
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              恢复{recycleNames[r.kind]}
            </Button>
            <Button
              onClick={() => {
                setTarget(r);
                setSecond(false);
                setError('');
              }}
            >
              永久删除
            </Button>
          </div>
        </article>
      ))}
      {target && (
        <Confirm
          title={second ? '最后确认：永久删除' : '永久删除前确认'}
          confirmLabel={second ? '我确认永久删除' : '继续确认'}
          onClose={() => setTarget(undefined)}
          onConfirm={async () => {
            if (!second) {
              setSecond(true);
              return;
            }
            try {
              await purgeEntity(target.kind, target.id);
              setTarget(undefined);
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          <p>
            永久删除“{target.name}
            ”将同时清理依赖它的聊天、事件、场景、记忆及报告等记录，可能涉及其他参与者的共同历史。此操作无法撤销。
          </p>
          <p>
            {second
              ? '这是第二次确认。需要保留记录时，请取消并导出完整备份。'
              : '下一步仍需再次确认，不会立即删除。'}
          </p>
          {error && <Status error>{error}</Status>}
        </Confirm>
      )}
    </div>
  );
}
