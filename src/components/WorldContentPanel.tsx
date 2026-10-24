import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { importMembers } from '../data/world-members';
import { createExpansion, runExpansion, acceptExpansion, possibleMatches } from '../ai/expansion';
import { newCharacter } from '../data/seed';
import { uid } from '../core/types';
import { CharacterEditor } from '../pages/Characters';
import { RelationshipAssistant } from './RelationshipAssistant';
import { MultiSelect } from './MultiSelect';
import { Button, Field, Input, Textarea, Select, Status, Modal } from './ui';
export function WorldContentPanel({ worldId, onClose }: { worldId: string; onClose: () => void }) {
  const data = useLiveQuery(
    async () => ({
      chars: await db.characters.filter((c) => !c.deletedAt).toArray(),
      members: await db.memberships.where('worldId').equals(worldId).toArray(),
      groups: await db.groups.filter((g) => !g.deletedAt).toArray(),
      gm: await db.groupMembers.toArray(),
      jobs: await db.expansionJobs.where('worldId').equals(worldId).reverse().sortBy('createdAt'),
    }),
    [worldId],
  );
  const [mode, setMode] = useState('menu'),
    [selected, setSelected] = useState<string[]>([]),
    [source, setSource] = useState(''),
    [group, setGroup] = useState(''),
    [names, setNames] = useState(''),
    [constraints, setConstraints] = useState(''),
    [target, setTarget] = useState(20),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [edit, setEdit] = useState(false),
    [jobId, setJobId] = useState(''),
    [relations, setRelations] = useState(false);
  const abort = useRef<AbortController>();
  const job =
    data?.jobs.find((j) => j.id === jobId) ??
    data?.jobs.filter((j) => j.status !== 'applied').at(-1);
  async function run(id: string) {
    setBusy(true);
    abort.current = new AbortController();
    try {
      await runExpansion(id, db, undefined, abort.current.signal);
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="添加内容"
      wide
      onClose={() => {
        abort.current?.abort();
        onClose();
      }}
    >
      <nav className="management-tabs" aria-label="添加方式">
        {[
          ['menu', '选择方式'],
          ['import', '从角色池导入'],
          ['create', '创建新角色'],
          ['batch', '批量新增角色'],
          ['ai', 'AI 扩展世界'],
        ].map(([id, label]) => (
          <Button key={id} onClick={() => setMode(id)} aria-selected={mode === id}>
            {label}
          </Button>
        ))}
      </nav>
      {mode === 'menu' && (
        <div className="create-options">
          <Button onClick={() => setMode('import')}>从已有角色池导入 · 共享原 ID</Button>
          <Button onClick={() => setMode('create')}>创建新角色 · 手动 / AI 帮写</Button>
          <Button onClick={() => setMode('batch')}>批量新增角色</Button>
          <Button onClick={() => setMode('ai')}>AI 扩展世界 · 角色、团体</Button>
        </div>
      )}
      {mode === 'create' && (
        <>
          <p>新角色保存后自动加入当前世界；AI 建议需你确认。</p>
          <Button onClick={() => setEdit(true)}>打开角色创建器</Button>
        </>
      )}
      {edit && <CharacterEditor worldId={worldId} onClose={() => setEdit(false)} />}
      {mode === 'import' && (
        <>
          <div className="form-grid">
            <Field label="来源作品">
              <Select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">所有来源</option>
                {[...new Set(data?.chars.map((c) => c.source))].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </Select>
            </Field>
            <Field label="已有团体">
              <Select value={group} onChange={(e) => setGroup(e.target.value)}>
                <option value="">所有团体</option>
                {data?.groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <MultiSelect
            label="角色池"
            options={(data?.chars ?? [])
              .filter(
                (c) =>
                  (!source || c.source === source) &&
                  (!group || data?.gm.some((m) => m.groupId === group && m.characterId === c.id)),
              )
              .map((c) => ({
                ...c,
                character: c,
                detail: data?.members.some((m) => m.characterId === c.id && !m.inactive)
                  ? '已在当前世界'
                  : c.source,
                disabled: data?.members.some((m) => m.characterId === c.id && !m.inactive),
              }))}
            value={selected}
            onChange={setSelected}
          />
          <footer className="modal-actions">
            <Button onClick={() => setSelected([])}>取消选择</Button>
            <Button
              variant="primary"
              disabled={!selected.length}
              onClick={async () => {
                try {
                  await importMembers(worldId, selected);
                  setSelected([]);
                  setNotice('已加入当前世界，全局资料与其他世界覆盖保持原样。');
                } catch (e) {
                  setNotice(String(e));
                }
              }}
            >
              确认导入 {selected.length} 名角色
            </Button>
          </footer>
        </>
      )}
      {mode === 'batch' && (
        <>
          <Field label="角色名字（每行一个）">
            <Textarea rows={8} value={names} onChange={(e) => setNames(e.target.value)} />
          </Field>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                const rows = [
                  ...new Set(
                    names
                      .split('\n')
                      .map((n) => n.trim())
                      .filter(Boolean),
                  ),
                ];
                if (!rows.length || rows.length > 200 || rows.some((n) => n.length > 60))
                  throw new Error('填写1～200个名字，每个不超过60字');
                if (rows.some((n) => possibleMatches(n, [], data?.chars ?? []).length))
                  throw new Error('存在可能重复的人物，请改用角色池导入或 AI 预览确认');
                await db.transaction('rw', db.characters, db.memberships, async () => {
                  for (const name of rows) {
                    const c = newCharacter(name);
                    await db.characters.add(c);
                    await db.memberships.add({
                      id: uid('member'),
                      worldId,
                      characterId: c.id,
                      identity: '',
                      bioOverride: '',
                      styleOverride: '',
                    });
                  }
                });
                setNames('');
                setNotice('已批量创建并加入世界');
              } catch (e) {
                setNotice(String(e));
              }
            }}
          >
            确认批量创建
          </Button>
        </>
      )}
      {mode === 'ai' && (
        <>
          <Field label="希望增加什么？">
            <Textarea
              value={constraints}
              onChange={(e) => setConstraints(e.target.value)}
              placeholder="补充妖怪之山的主要角色，遵循原作；不要重复已有成员"
            />
          </Field>
          <Field label="目标新增人数（1～200，自动每批最多5人）">
            <Input
              type="number"
              min={1}
              max={200}
              value={target}
              onChange={(e) => setTarget(Number(e.target.value))}
            />
          </Field>
          <Button
            disabled={busy || !constraints.trim()}
            onClick={async () => {
              try {
                const j = await createExpansion(worldId, constraints, target);
                setJobId(j.id);
                await run(j.id);
              } catch (e) {
                setNotice(String(e));
              }
            }}
          >
            创建并分批生成
          </Button>
          {!!data?.jobs.length && (
            <Field label="恢复已保存草稿">
              <Select value={job?.id ?? ''} onChange={(e) => setJobId(e.target.value)}>
                {data.jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.constraints.slice(0, 30)} · {j.characters.length}/{j.target} · {j.status}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {job && (
            <section className="settings-section">
              <strong>
                完整人物草稿 {job.characters.length} / {job.target} ·{' '}
                {job.status === 'applied' ? '已应用' : '未写入世界'}
              </strong>
              {job.error && <Status error>{job.error}</Status>}
              <div className="toolbar">
                <Button
                  disabled={busy || job.status === 'applied' || job.characters.length >= job.target}
                  onClick={() => void run(job.id)}
                >
                  继续剩余批次
                </Button>
                <Button disabled={!busy} onClick={() => abort.current?.abort()}>
                  取消生成，保留草稿
                </Button>
              </div>
              {!busy && job.status !== 'applied' && (
                <>
                  <div className="diff-list">
                    {job.characters.map((c, i) => {
                      const matches = possibleMatches(c.name, c.aliases, data?.chars ?? []);
                      const decision = job.decisions[String(i)];
                      return (
                        <details key={i} className="settings-section">
                          <summary>
                            {c.name} · {matches.length ? '可能重复，必须确认' : '新人物草稿'}
                          </summary>
                          <Field label="草稿姓名">
                            <Input
                              value={c.name}
                              onChange={(e) =>
                                void db.expansionJobs.update(job.id, {
                                  characters: job.characters.map((v, k) =>
                                    k === i ? { ...v, name: e.target.value } : v,
                                  ),
                                })
                              }
                            />
                          </Field>
                          {(['bio', 'personality', 'style', 'habits'] as const).map((key) => (
                            <Field
                              key={key}
                              label={
                                { bio: '资料', personality: '性格', style: '表达', habits: '习惯' }[
                                  key
                                ]
                              }
                            >
                              <Textarea
                                value={c[key]}
                                onChange={(e) =>
                                  void db.expansionJobs.update(job.id, {
                                    characters: job.characters.map((v, k) =>
                                      k === i ? { ...v, [key]: e.target.value } : v,
                                    ),
                                  })
                                }
                              />
                            </Field>
                          ))}
                          <Field label="人物处理方式">
                            <Select
                              value={decision?.action ?? ''}
                              onChange={(e) =>
                                void db.expansionJobs.update(job.id, {
                                  decisions: {
                                    ...job.decisions,
                                    [String(i)]: {
                                      action: e.target.value as 'new',
                                      characterId: decision?.characterId ?? matches[0]?.id,
                                    },
                                  },
                                })
                              }
                            >
                              <option value="" disabled>
                                {matches.length ? '请选择处理方式' : '默认创建新角色'}
                              </option>
                              <option value="new">创建独立新角色</option>
                              <option value="use">使用已有角色</option>
                              <option value="merge">合并到世界覆盖（不改全局资料）</option>
                              <option value="skip">跳过</option>
                            </Select>
                          </Field>
                          {(decision?.action === 'use' || decision?.action === 'merge') && (
                            <Select
                              aria-label="使用哪个已有角色"
                              value={decision.characterId ?? ''}
                              onChange={(e) =>
                                void db.expansionJobs.update(job.id, {
                                  decisions: {
                                    ...job.decisions,
                                    [String(i)]: { ...decision, characterId: e.target.value },
                                  },
                                })
                              }
                            >
                              {(data?.chars ?? []).map((p) => (
                                <option value={p.id} key={p.id}>
                                  {p.name} · {p.source}
                                </option>
                              ))}
                            </Select>
                          )}
                        </details>
                      );
                    })}
                  </div>
                  <h3>团体草稿（删除不需要的团体）</h3>
                  {job.groups.map((g, i) => (
                    <div className="settings-section" key={i}>
                      <Input
                        aria-label="团体草稿名称"
                        value={g.name}
                        onChange={(e) =>
                          void db.expansionJobs.update(job.id, {
                            groups: job.groups.map((v, k) =>
                              k === i ? { ...v, name: e.target.value } : v,
                            ),
                          })
                        }
                      />
                      <p>{g.memberNames.join('、')}</p>
                      <Button
                        onClick={() =>
                          void db.expansionJobs.update(job.id, {
                            groups: job.groups.filter((_, k) => k !== i),
                          })
                        }
                      >
                        删除此团体草稿
                      </Button>
                    </div>
                  ))}
                  <footer className="modal-actions">
                    <Button
                      variant="primary"
                      disabled={!job.characters.length}
                      onClick={async () => {
                        try {
                          await acceptExpansion(job.id);
                          setNotice(
                            '已增量保存。原有世界、时间和历史保留。可在下方选择 AI 补充关系，或暂时跳过。',
                          );
                          setRelations(true);
                        } catch (e) {
                          setNotice(String(e));
                        }
                      }}
                    >
                      确认应用当前草稿
                    </Button>
                  </footer>
                </>
              )}
            </section>
          )}
          {relations && <RelationshipAssistant worldId={worldId} />}
        </>
      )}
      {notice && <Status>{notice}</Status>}
    </Modal>
  );
}
