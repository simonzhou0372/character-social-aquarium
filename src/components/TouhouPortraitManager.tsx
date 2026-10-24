import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, withWorldLock } from '../data/db';
import { touhouPortraits, PORTRAIT_PACK } from '../data/presets/touhou-portraits';
import { downloadPortraits, removePortraits, type PortraitProgress } from '../data/portraits';
import { Button, Confirm, Field, Modal, Select, Status, Toggle } from './ui';
import { MultiSelect } from './MultiSelect';
export function TouhouPortraitEntry({ worldId }: { worldId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>东方头像素材（可选下载）</Button>
      {open && <TouhouPortraitManager worldId={worldId} onClose={() => setOpen(false)} />}
    </>
  );
}
function TouhouPortraitManager({ worldId, onClose }: { worldId?: string; onClose: () => void }) {
  const characters = useLiveQuery(() => db.characters.toArray(), []);
  const [scope, setScope] = useState(
      worldId === 'w-touhou-pc98' ? 'pc98' : worldId ? 'windows' : '',
    ),
    [filter, setFilter] = useState('available'),
    [selected, setSelected] = useState<string[]>([]),
    [replace, setReplace] = useState(false),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState<PortraitProgress>(),
    [notice, setNotice] = useState(''),
    [confirmRemove, setConfirmRemove] = useState(false),
    [cancelled, setCancelled] = useState(false);
  const controller = useRef<AbortController>();
  useEffect(() => () => controller.current?.abort(), []);
  const chars = new Map(characters?.map((c) => [c.id, c]));
  const status = (id: string) => {
    const c = chars.get(id);
    if (!c || c.deletedAt) return '未安装 / 已回收';
    if (c.avatar && c.avatarSource?.pack === PORTRAIT_PACK) return '已下载';
    if (c.avatar) return '已有自定义头像 · 保留';
    return '未下载';
  };
  const visible = touhouPortraits.filter(
    (e) =>
      (!scope || e.continuity === scope) &&
      (filter === 'all' ||
        (filter === 'missing'
          ? !e.candidates.length
          : filter === 'downloaded'
            ? status(e.characterId) === '已下载'
            : !!e.candidates.length)),
  );
  const ready = selected.filter((id) => {
    const c = chars.get(id);
    return c && !c.deletedAt && (!c.avatar || (replace && c.avatarSource?.pack === PORTRAIT_PACK));
  });
  const bytes = selected.reduce(
    (sum, id) =>
      sum + (touhouPortraits.find((e) => e.characterId === id)?.candidates[0]?.bytes ?? 0),
    0,
  );
  async function download() {
    setBusy(true);
    setCancelled(false);
    setNotice('');
    controller.current = new AbortController();
    try {
      const result = await withWorldLock('touhou-portraits', () =>
        downloadPortraits(ready, {
          signal: controller.current!.signal,
          replaceDownloaded: replace,
          onProgress: setProgress,
        }),
      );
      if (!result) setNotice('另一个页面正在下载东方头像，请等待其完成。');
      else if (controller.current.signal.aborted) {
        setCancelled(true);
        setNotice('已取消下载，已完成的头像保留；重新点击下载会跳过已完成项。');
      } else
        setNotice(
          `下载完成：应用 ${result.installed} 张，跳过 ${result.skipped} 项，失败 ${result.failed} 项。失败项可重新下载。`,
        );
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
    }
  }
  const available = touhouPortraits.filter((e) => e.candidates.length).length;
  return (
    <Modal title="东方头像素材" onClose={onClose} wide>
      <p>
        可确认立绘 {available} / {touhouPortraits.length}{' '}
        名。图片不随程序分发，也不会自动请求；只有点击下载后才从 THBWiki
        素材站获取并保存到当前浏览器。
      </p>
      <p>
        优先黄昏边境作品立绘（alphes、春河萌、TOKIAME 等），其次 ZUN
        绘；旧作单独匹配。不混用同人图、两只铃仙或新旧作人设，没有可确认立绘时保留默认头像。
      </p>
      <div className="form-grid">
        <Field label="头像预设范围">
          <Select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">全部东方预设</option>
            <option value="windows">Windows / 官方书籍档案</option>
            <option value="pc98">PC-98 旧作档案</option>
          </Select>
        </Field>
        <Field label="头像素材筛选">
          <Select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="available">有可确认立绘</option>
            <option value="all">全部档案（含缺失原因）</option>
            <option value="missing">暂缺对应立绘</option>
            <option value="downloaded">已下载</option>
          </Select>
        </Field>
      </div>
      <Toggle
        label="更新以前通过此入口下载的头像（仍保留自行上传的头像）"
        checked={replace}
        onChange={setReplace}
      />
      <MultiSelect
        label="东方头像角色"
        options={visible.map((e) => {
          const c = chars.get(e.characterId),
            source = e.candidates[0];
          return {
            id: e.characterId,
            name: e.name,
            character: c,
            disabled:
              busy ||
              !source ||
              !c ||
              !!c.deletedAt ||
              (!!c.avatar && !(replace && c.avatarSource?.pack === PORTRAIT_PACK)),
            detail: source
              ? `${status(e.characterId)} · ${source.kind === 'twilight' ? '黄昏' : 'ZUN'} · ${source.work} / ${source.artist}`
              : e.missingReason,
            search: e.candidates.map((c) => `${c.work} ${c.artist}`).join(' '),
          };
        })}
        value={selected}
        onChange={setSelected}
      />
      <p>
        已选 {selected.length} 名，待下载 {ready.length} 张；按首选原图大小估算约{' '}
        {(bytes / 1024 / 1024).toFixed(1)} MB（实际下载 256
        像素缩略图，通常更小）。下载失败时尝试已核对的备用立绘，最终以实际用量为准。不会发送角色资料、聊天、提示词或
        API 密钥。
      </p>
      <details>
        <summary>查看所选素材来源、画师与备用顺序</summary>
        {touhouPortraits
          .filter((e) => selected.includes(e.characterId))
          .map((e) => (
            <article key={e.characterId}>
              <strong>{e.name}</strong>
              <ol>
                {e.candidates.map((c) => (
                  <li key={c.id}>
                    <a href={c.sourcePage} target="_blank" rel="noreferrer">
                      {c.work} · {c.artist} · 原图说明
                    </a>
                  </li>
                ))}
              </ol>
            </article>
          ))}
      </details>
      <p>
        官方立绘不属于本项目的开源授权范围，使用与再分发需遵守
        <a href="https://touhou-project.news/guideline/" target="_blank" rel="noreferrer">
          东方使用指南
        </a>
        及作品方条件。下载存档可随本地备份导出，清空浏览器数据会丢失。
      </p>
      {progress && (
        <Status>
          {busy ? '正在下载' : cancelled ? '下载已取消' : '本次下载结果'}：{progress.completed} /{' '}
          {progress.total} · 已应用 {progress.installed} · 失败 {progress.failed}
          {busy && progress.current && ` · ${progress.current}`}
          {!!progress.errors.length && (
            <details>
              <summary>失败原因 / 重试提示</summary>
              {progress.errors.map((e, i) => (
                <p key={i}>{e}</p>
              ))}
            </details>
          )}
        </Status>
      )}
      {notice && <Status>{notice}</Status>}
      <footer className="modal-actions">
        <Button disabled={busy} onClick={() => setConfirmRemove(true)}>
          清除已下载的东方头像
        </Button>
        {busy ? (
          <Button onClick={() => controller.current?.abort()}>取消下载</Button>
        ) : (
          <Button variant="primary" disabled={!ready.length} onClick={() => void download()}>
            下载并应用 {ready.length} 张头像
          </Button>
        )}
      </footer>
      {confirmRemove && (
        <Confirm
          title="清除已下载的东方头像？"
          confirmLabel="确认清除素材"
          onClose={() => setConfirmRemove(false)}
          onConfirm={async () => {
            try {
              setNotice(`已清除 ${await removePortraits()} 张下载头像；自行上传的头像保留。`);
            } catch (e) {
              setNotice(String(e));
            } finally {
              setConfirmRemove(false);
            }
          }}
        >
          只清除与本素材包下载结果一致的头像，不删除角色或历史。以后可以重新选择下载。
        </Confirm>
      )}
    </Modal>
  );
}
