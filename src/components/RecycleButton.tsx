import { useState } from 'react';
import { Button, Confirm, Status } from './ui';
import { recycleEntity, recycleNames, type RecycleKind } from '../data/recycle';
export function RecycleButton({
  kind,
  id,
  name,
  onDone,
}: {
  kind: RecycleKind;
  id: string;
  name: string;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false),
    [error, setError] = useState('');
  return (
    <>
      <Button aria-label={`删除${name}`} onClick={() => setOpen(true)}>
        移入回收站
      </Button>
      {open && (
        <Confirm
          title={`删除${recycleNames[kind]}？`}
          confirmLabel="确认移入回收站"
          onClose={() => setOpen(false)}
          onConfirm={async () => {
            try {
              await recycleEntity(kind, id);
              setOpen(false);
              onDone?.();
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          <p>将“{name}”移入回收站，停止其后续模拟。已有设定与历史保留，可在回收站恢复。</p>
          {error && <Status error>{error}</Status>}
        </Confirm>
      )}
    </>
  );
}
