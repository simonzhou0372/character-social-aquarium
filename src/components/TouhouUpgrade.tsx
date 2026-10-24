import { TouhouPortraitEntry } from './TouhouPortraitManager';
import { useState } from 'react';
import {
  previewTouhouUpgrade,
  applyTouhouUpgrade,
  resetTouhouWorld,
  type PresetDiff,
} from '../data/presets/touhou-upgrade';
import { TOUHOU_WORLD_ID, TOUHOU_LEGACY_ID, TOUHOU_PRESET_VERSION } from '../data/presets/touhou';
import { Button, Confirm, Status, Select } from './ui';
import { MultiSelect } from './MultiSelect';
export function TouhouUpgrade({ worldId }: { worldId: string }) {
  const [rows, setRows] = useState<PresetDiff[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [mode, setMode] = useState('defaults'),
    [notice, setNotice] = useState(''),
    [reset, setReset] = useState(0);
  if (![TOUHOU_WORLD_ID, TOUHOU_LEGACY_ID].includes(worldId)) return null;
  return (
    <section className="panel" aria-label="东方预设维护">
      <h3>东方预设 v{TOUHOU_PRESET_VERSION} · 资料更新与维护</h3>
      <p>可先预览差异补充新版资料，保留现有历史。只有下方重建按钮会清除当前东方世界历史。</p>
      <TouhouPortraitEntry worldId={worldId} />
      <Button variant="danger" onClick={() => setReset(1)}>
        删除旧东方历史并重建此世界
      </Button>
      <details open>
        <summary>人物与关系校准 · 差异更新</summary>
        <p>
          数值与行为是基于原作的模拟解释，不是官方量表。旧设定不会自动覆盖。锁定关系不可更新，需先在关系编辑中手动解锁。重建可直接使用全套新版默认配置。
        </p>
        <Button
          onClick={async () => {
            try {
              const diff = await previewTouhouUpgrade(worldId);
              setRows(diff);
              setSelected(diff.filter((r) => !r.blocked).map((r) => `${r.id}:${r.field}`));
            } catch (e) {
              setNotice(String(e));
            }
          }}
        >
          预览新版差异
        </Button>
        <Select aria-label="预设更新策略" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="defaults">只更新仍为旧默认值的字段（可选择）</option>
          <option value="missing">仅补充缺失关系</option>
        </Select>
        {!!rows.length && (
          <>
            <MultiSelect
              label="预设更新字段"
              options={rows.map((r) => ({
                id: `${r.id}:${r.field}`,
                name: `${r.name} · ${r.field}`,
                detail: r.blocked
                  ? r.reason
                  : `${JSON.stringify(r.before)} → ${JSON.stringify(r.after)}`,
                disabled: r.blocked || (mode === 'missing' && r.field !== 'missing'),
              }))}
              value={selected}
              onChange={setSelected}
            />
            <details>
              <summary>完整差异</summary>
              <div className="diff-list">
                {rows.map((r) => (
                  <p key={`${r.id}:${r.field}`}>
                    <b>
                      {r.name} / {r.field}
                    </b>
                    <br />
                    {JSON.stringify(r.before)} → {JSON.stringify(r.after)}{' '}
                    {r.blocked && `（保护：${r.reason}）`}
                  </p>
                ))}
              </div>
            </details>
            <Button
              onClick={async () => {
                try {
                  setNotice(
                    `已应用 ${await applyTouhouUpgrade(worldId, selected, mode === 'missing')} 项安全更新`,
                  );
                } catch (e) {
                  setNotice(String(e));
                }
              }}
            >
              确认应用所选差异
            </Button>
          </>
        )}
      </details>
      {reset > 0 && (
        <Confirm
          title={reset === 1 ? '重建内置东方世界' : '再次确认永久清除旧东方历史'}
          onClose={() => setReset(0)}
          confirmLabel={reset === 1 ? '继续确认' : '确认永久清除并重建'}
          onConfirm={async () => {
            if (reset === 1) {
              setReset(2);
              return;
            }
            try {
              await resetTouhouWorld(worldId);
              setRows([]);
              setReset(0);
              setNotice(`已重建为 v${TOUHOU_PRESET_VERSION} 预设，当前暂停；其他世界保留。`);
            } catch (e) {
              setNotice(String(e));
              setReset(0);
            }
          }}
        >
          <p>
            将永久清除当前内置东方世界的聊天、生活事件、场景、报告与世界成员配置，并换用新版默认资料。其他世界和其引用的全局角色保留。此操作无法恢复。
          </p>
        </Confirm>
      )}
      {notice && <Status>{notice}</Status>}
    </section>
  );
}
