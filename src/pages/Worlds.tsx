import { WorldDateEditor } from '../components/WorldDateEditor';
import { realLocalDate } from '../core/calendar';
import { BackgroundKnowledgeEditor } from '../components/BackgroundKnowledgeEditor';
import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Globe2, Users, ArrowUpRight, BookOpen, Save } from 'lucide-react';
import { db } from '../data/db';
import { uid, WorldSchema, type World, type Group, type Character } from '../core/types';
import {
  Button,
  Field,
  Input,
  Textarea,
  Select,
  Modal,
  Status,
  Empty,
  Avatar,
  Confirm,
} from '../components/ui';
import { TimeControls } from '../components/TimeControls';
import { CharacterEditor } from './Characters';
import {
  createWorld,
  saveGroupMembers,
  exportWorld,
  importWorld,
  validateWorldPackage,
  type WorldPackage,
} from '../data/worlds';
import { CreationAssistant } from '../components/CreationAssistant';
import { type CharacterDraft } from '../ai/drafts';
import { downloadJson } from '../data/backup';
export function Worlds({
  worldId,
  onSelect,
  onConversation,
}: {
  worldId: string;
  onSelect: (id: string) => void;
  onConversation: (id: string) => void;
}) {
  const worlds = useLiveQuery(() => db.worlds.toArray(), []),
    groups = useLiveQuery(() => db.groups.toArray(), []),
    chars = useLiveQuery(() => db.characters.toArray(), []),
    members = useLiveQuery(() => db.memberships.toArray(), []),
    gm = useLiveQuery(() => db.groupMembers.toArray(), []);
  const [edit, setEdit] = useState<World>(),
    [group, setGroup] = useState<Group>(),
    [participants, setParticipants] = useState<string[]>([]),
    [error, setError] = useState(''),
    [knowledge, setKnowledge] = useState(''),
    [knowledgeOwners, setKnowledgeOwners] = useState<string[]>([]),
    [showKnowledge, setShowKnowledge] = useState(false);
  const [editCharacter, setEditCharacter] = useState<Character | null | undefined>();
  const [selectedCharacters, setSelectedCharacters] = useState<string[]>([]),
    [selectedGroups, setSelectedGroups] = useState<string[]>([]),
    [newNames, setNewNames] = useState(''),
    [newGroups, setNewGroups] = useState('');
  const [packagePreview, setPackagePreview] = useState<WorldPackage>(),
    [pageError, setPageError] = useState('');
  const importFile = useRef<HTMLInputElement>(null);
  const [worldDrafts, setWorldDrafts] = useState<CharacterDraft[]>([]),
    [draftGroups, setDraftGroups] = useState<Record<string, string>>({});
  const [groupNewNames, setGroupNewNames] = useState(''),
    [groupDrafts, setGroupDrafts] = useState<CharacterDraft[]>([]),
    [confirmedOutside, setConfirmedOutside] = useState<string[]>([]),
    [outsideCandidate, setOutsideCandidate] = useState<Character>();
  const worldSelectedNames =
    chars
      ?.filter(
        (c) =>
          selectedCharacters.includes(c.id) ||
          gm?.some((m) => selectedGroups.includes(m.groupId) && m.characterId === c.id),
      )
      .map((c) => c.name) ?? [];
  const isNew = !!edit && !worlds?.some((w) => w.id === edit.id);
  async function saveWorld() {
    if (!edit) return;
    try {
      const w = WorldSchema.parse(edit);
      new Intl.DateTimeFormat('zh', { timeZone: w.timezone });
      if (isNew)
        await createWorld(
          w,
          selectedCharacters,
          selectedGroups,
          newNames.split('\n'),
          newGroups.split('\n'),
          db,
          worldDrafts,
          draftGroups,
        );
      else await db.worlds.put(w);
      setEdit(undefined);
      onSelect(w.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : '请检查世界名称、场景和有效时区。');
    }
  }
  async function saveGroup() {
    if (!group) return;
    try {
      await saveGroupMembers(
        group,
        worldId,
        participants,
        groupNewNames.split('\n'),
        groupDrafts,
        confirmedOutside,
      );
      setGroup(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
  }
  return (
    <div>
      <div className="page-heading">
        <div>
          <span className="eyebrow">WORLDS / 世界与团体</span>
          <h1>
            故事发生的地方<span>◈</span>
          </h1>
          <p>平行世界可以共享角色，各自保留不同的人生。</p>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            setError('');
            setSelectedCharacters([]);
            setSelectedGroups([]);
            setNewNames('');
            setNewGroups('');
            setWorldDrafts([]);
            setDraftGroups({});
            setEdit({
              id: uid('world'),
              name: '',
              description: '',
              rules: '现代现实，无超自然能力。尊重角色边界。',
              locations: ['咖啡馆', '学校', '家'],
              timezone: 'Asia/Shanghai',
              tone: '轻松日常',
              color: '#d9ef69',
            });
          }}
        >
          <Plus size={16} />
          添加世界观
        </Button>
      </div>
      <div className="toolbar">
        <Button onClick={() => importFile.current?.click()}>导入世界观包</Button>
        <span className="muted">
          添加世界观时可批量导入角色与团体；点击「进入世界」即可切换观察。
        </span>
        <input
          ref={importFile}
          hidden
          type="file"
          accept=".json"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              if (file.size > 20 * 1024 * 1024) throw new Error('世界观包超过 20 MB');
              setPackagePreview(validateWorldPackage(JSON.parse(await file.text())));
            } catch (err) {
              setPageError(err instanceof Error ? err.message : '世界观包无效');
            }
            e.target.value = '';
          }}
        />
      </div>
      {pageError && <Status error>{pageError}</Status>}
      <div className="world-grid">
        {worlds?.map((w) => (
          <article className={`world-card ${w.id === worldId ? 'selected' : ''}`} key={w.id}>
            <div className="world-cover">
              <Globe2 size={74} strokeWidth={1} />
              <span>PARALLEL WORLD</span>
              <b>{w.name.slice(0, 2)}</b>
            </div>
            <div>
              <span className="tag">
                {members?.filter((m) => m.worldId === w.id).length} 位角色
              </span>
              <h2>{w.name}</h2>
              <p>{w.description}</p>
              <div className="toolbar">
                <Button onClick={() => onSelect(w.id)}>
                  {w.id === worldId ? '当前世界' : '进入世界'}
                  <ArrowUpRight size={15} />
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setError('');
                    setEdit(w);
                  }}
                >
                  编辑设定
                </Button>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    try {
                      downloadJson(await exportWorld(w.id), `${w.name}-世界观.json`);
                    } catch (e) {
                      setPageError(String(e));
                    }
                  }}
                >
                  导出世界观
                </Button>
              </div>
            </div>
          </article>
        ))}
      </div>
      <TimeControls worldId={worldId} compact />
      <section className="panel world-characters">
        <div className="section-title">
          <div>
            <span className="eyebrow">PEOPLE IN THIS WORLD</span>
            <h2>当前世界的角色</h2>
          </div>
          <Button variant="primary" onClick={() => setEditCharacter(null)}>
            <Plus size={16} />
            添加角色
          </Button>
        </div>
        <div className="world-character-list">
          {chars
            ?.filter((c) => members?.some((m) => m.worldId === worldId && m.characterId === c.id))
            .map((c) => (
              <button key={c.id} onClick={() => setEditCharacter(c)}>
                <Avatar character={c} size={44} />
                <span>
                  <strong>{c.name}</strong>
                  <small>查看 / 编辑资料</small>
                </span>
              </button>
            ))}
        </div>
        {!members?.some((m) => m.worldId === worldId) && (
          <Empty
            title="世界里还没有角色"
            description="添加角色，或编辑角色资料将已有角色加入此世界。"
          />
        )}
      </section>
      <div className="section-title spaced">
        <div>
          <span className="eyebrow">LITTLE CIRCLES</span>
          <h2>属于他们的小圈子</h2>
        </div>
        <Button
          onClick={() => {
            setError('');
            setParticipants([]);
            setGroupNewNames('');
            setGroupDrafts([]);
            setConfirmedOutside([]);
            setGroup({
              id: uid('group'),
              name: '',
              description: '',
              worldIds: [worldId],
              color: '#d9ef69',
            });
          }}
        >
          <Plus size={16} />
          创建团体
        </Button>
      </div>
      <div className="group-grid">
        {groups
          ?.filter((g) => g.worldIds.includes(worldId))
          .map((g) => (
            <article className="panel group-card" key={g.id}>
              <div className="group-symbol">
                <Users size={24} />
              </div>
              <h3>{g.name}</h3>
              <p>{g.description}</p>
              <div className="avatar-stack">
                {gm
                  ?.filter((m) => m.groupId === g.id && m.worldId === worldId)
                  .map((m) => (
                    <Avatar
                      key={m.id}
                      character={chars?.find((c) => c.id === m.characterId)}
                      size={36}
                    />
                  ))}
              </div>
              <div className="toolbar">
                <Button
                  onClick={async () => {
                    const c = await db.conversations
                      .where('groupId')
                      .equals(g.id)
                      .and((c) => c.worldId === worldId)
                      .first();
                    if (c) onConversation(c.id);
                  }}
                >
                  旁观群聊
                  <ArrowUpRight size={15} />
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setError('');
                    setGroupNewNames('');
                    setGroupDrafts([]);
                    setConfirmedOutside([]);
                    setParticipants(
                      gm
                        ?.filter((m) => m.groupId === g.id && m.worldId === worldId)
                        .map((m) => m.characterId) ?? [],
                    );
                    setGroup(g);
                  }}
                >
                  成员 / 编辑
                </Button>
              </div>
            </article>
          ))}
      </div>
      <BackgroundKnowledgeEditor worldId={worldId} />
      <section className="panel knowledge-entry">
        <BookOpen size={28} />
        <div>
          <h3>世界知识库</h3>
          <p>导入 TXT / Markdown，明确哪些角色知道这些事。</p>
        </div>
        <Button onClick={() => setShowKnowledge(true)}>添加知识</Button>
      </section>
      {edit && (
        <Modal title="世界观设定" onClose={() => setEdit(undefined)}>
          <Field label="世界名称">
            <Input
              value={edit.name}
              maxLength={80}
              onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            />
          </Field>
          <Field label="纪年名称">
            <Input
              value={edit.era ?? 'AD'}
              onChange={(e) => setEdit({ ...edit, era: e.target.value })}
            />
          </Field>
          {!worlds?.some((w) => w.id === edit.id) ? (
            <WorldDateEditor
              label="故事从哪一天开始？"
              value={edit.initialDate ?? realLocalDate(Date.now(), edit.timezone)}
              onChange={(date) => setEdit({ ...edit, initialDate: date })}
            />
          ) : (
            <p className="muted">
              纪年名称可直接修改；日期调整请在时间控制中创建安全分支，原历史保留。
            </p>
          )}
          <Field label="介绍">
            <Textarea
              value={edit.description}
              onChange={(e) => setEdit({ ...edit, description: e.target.value })}
            />
          </Field>
          <Field label="世界规则（事实约束优先于全局语言规范）">
            <Textarea
              rows={4}
              value={edit.rules}
              onChange={(e) => setEdit({ ...edit, rules: e.target.value })}
            />
          </Field>
          <Field label="场景（每行一个）">
            <Textarea
              value={edit.locations.join('\n')}
              onChange={(e) => setEdit({ ...edit, locations: e.target.value.split('\n') })}
            />
          </Field>
          <div className="form-grid">
            <Field label="时区">
              <Input
                value={edit.timezone}
                onChange={(e) => setEdit({ ...edit, timezone: e.target.value })}
              />
            </Field>
            <Field label="故事基调">
              <Input
                value={edit.tone}
                onChange={(e) => setEdit({ ...edit, tone: e.target.value })}
              />
            </Field>
          </div>
          {isNew && (
            <>
              <h3>快速导入角色与团体</h3>
              <Field label="从已有角色加入">
                <div className="check-list">
                  {chars?.map((c) => (
                    <label key={c.id}>
                      <input
                        type="checkbox"
                        checked={selectedCharacters.includes(c.id)}
                        onChange={(e) =>
                          setSelectedCharacters(
                            e.target.checked
                              ? [...selectedCharacters, c.id]
                              : selectedCharacters.filter((id) => id !== c.id),
                          )
                        }
                      />
                      {c.name}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="从已有团体加入（成员自动加入）">
                <div className="check-list">
                  {groups?.map((g) => (
                    <label key={g.id}>
                      <input
                        type="checkbox"
                        checked={selectedGroups.includes(g.id)}
                        onChange={(e) =>
                          setSelectedGroups(
                            e.target.checked
                              ? [...selectedGroups, g.id]
                              : selectedGroups.filter((id) => id !== g.id),
                          )
                        }
                      />
                      {g.name}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="批量新增角色（每行一个名字）">
                <Textarea
                  rows={4}
                  value={newNames}
                  placeholder={'小夏\n小澪'}
                  onChange={(e) => setNewNames(e.target.value)}
                />
              </Field>
              <Button
                onClick={() =>
                  setNewNames(
                    [newNames, `新角色 ${newNames.split('\n').filter(Boolean).length + 1}`]
                      .filter(Boolean)
                      .join('\n'),
                  )
                }
              >
                <Plus size={15} />
                新增角色草稿
              </Button>
              <Field label="批量新增团体（每行：团体名：角色名、角色名）">
                <Textarea
                  value={newGroups}
                  placeholder="摄影社：小夏、小澪"
                  onChange={(e) => setNewGroups(e.target.value)}
                />
              </Field>
              <Button
                onClick={() => {
                  const names = [
                    ...worldSelectedNames,
                    ...newNames.split('\n').filter(Boolean),
                  ].slice(0, 2);
                  setNewGroups(
                    [newGroups, `新团体：${names.join('、')}`].filter(Boolean).join('\n'),
                  );
                }}
              >
                <Plus size={15} />
                新增团体草稿
              </Button>
              <p className="muted">
                勾选已有角色会共享全局资料，世界内覆盖仍独立。新角色保存后可逐个完善资料。
              </p>
            </>
          )}
          {isNew && (
            <CreationAssistant
              kind="world"
              known={{
                world: edit,
                selectedCharacters: worldSelectedNames,
                selectedGroups: groups?.filter((g) => selectedGroups.includes(g.id)),
                newCharacterNames: newNames,
                newGroupDescriptions: newGroups,
              }}
              existingNames={worldSelectedNames}
              onApply={(draft) => {
                if (draft.world) setEdit({ ...edit, ...draft.world, id: edit.id });
                setWorldDrafts(draft.characters);
                setNewNames(draft.characters.map((c) => c.name).join('\n'));
                setNewGroups(
                  draft.groups.map((g) => `${g.name}：${g.memberNames.join('、')}`).join('\n'),
                );
                setDraftGroups(
                  Object.fromEntries(draft.groups.map((g) => [g.name, g.description])),
                );
              }}
            />
          )}
          {error && <Status error>{error}</Status>}
          <Button variant="primary" onClick={saveWorld}>
            <Save size={16} />
            保存世界
          </Button>
        </Modal>
      )}
      {group && (
        <Modal title="团体与成员" onClose={() => setGroup(undefined)}>
          <Field label="团体模式">
            <select
              value={group.entityMode ?? 'interactive'}
              onChange={(e) =>
                setGroup({ ...group, entityMode: e.target.value as 'interactive' | 'background' })
              }
            >
              <option value="interactive">可互动团体</option>
              <option value="background">背景团体 / 传闻团体</option>
            </select>
          </Field>
          {group.entityMode === 'background' && (
            <Field label="名气程度（知识范围单独配置）">
              <Input
                type="range"
                min="0"
                max="100"
                value={group.fame ?? 0}
                onChange={(e) => setGroup({ ...group, fame: Number(e.target.value) })}
              />
            </Field>
          )}
          <Field label="团体名称">
            <Input
              value={group.name}
              onChange={(e) => setGroup({ ...group, name: e.target.value })}
            />
          </Field>
          <Field label="介绍">
            <Textarea
              value={group.description}
              onChange={(e) => setGroup({ ...group, description: e.target.value })}
            />
          </Field>
          <Field label="选择已有角色（高亮为当前世界成员）">
            <div className="check-list group-member-picker">
              {chars?.map((c) => {
                const inWorld = members?.some(
                  (m) => m.worldId === worldId && m.characterId === c.id,
                );
                return (
                  <label key={c.id} className={inWorld ? 'in-world' : 'outside-world'}>
                    <input
                      type="checkbox"
                      checked={participants.includes(c.id)}
                      onChange={(e) => {
                        if (!e.target.checked)
                          setParticipants(participants.filter((id) => id !== c.id));
                        else if (inWorld || confirmedOutside.includes(c.id))
                          setParticipants([...participants, c.id]);
                        else setOutsideCandidate(c);
                      }}
                    />
                    <Avatar character={c} size={28} />
                    <span>{c.name}</span>
                    <small>{inWorld ? '当前世界' : '世界外 · 加入前需确认'}</small>
                  </label>
                );
              })}
            </div>
          </Field>
          <Field label="新增角色（每行一个名字）">
            <Textarea
              rows={3}
              value={groupNewNames}
              onChange={(e) => setGroupNewNames(e.target.value)}
              placeholder={'新角色甲\n新角色乙'}
            />
          </Field>
          <Button
            onClick={() =>
              setGroupNewNames(
                [groupNewNames, `新角色 ${groupNewNames.split('\n').filter(Boolean).length + 1}`]
                  .filter(Boolean)
                  .join('\n'),
              )
            }
          >
            <Plus size={15} />
            新增角色草稿
          </Button>
          <CreationAssistant
            kind="group"
            known={{
              group,
              world: worlds?.find((w) => w.id === worldId),
              selectedCharacters: chars?.filter((c) => participants.includes(c.id)),
              newCharacterNames: groupNewNames,
            }}
            existingNames={
              chars?.filter((c) => participants.includes(c.id)).map((c) => c.name) ?? []
            }
            onApply={(draft) => {
              const g = draft.groups[0];
              if (!g) return;
              setGroup({ ...group, name: g.name, description: g.description });
              setGroupDrafts(draft.characters);
              setGroupNewNames(draft.characters.map((c) => c.name).join('\n'));
              setParticipants(
                chars
                  ?.filter((c) => participants.includes(c.id) && g.memberNames.includes(c.name))
                  .map((c) => c.id) ?? [],
              );
            }}
          />
          {error && <Status error>{error}</Status>}
          <Button variant="primary" onClick={saveGroup}>
            保存团体
          </Button>
        </Modal>
      )}
      {showKnowledge && (
        <Modal title="添加世界知识" onClose={() => setShowKnowledge(false)}>
          <Field label="知识内容">
            <Textarea
              rows={8}
              value={knowledge}
              maxLength={30000}
              onChange={(e) => setKnowledge(e.target.value)}
            />
          </Field>
          <label className="button">
            导入 TXT / Markdown
            <input
              type="file"
              hidden
              accept=".txt,.md"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f && f.size < 100000) setKnowledge((await f.text()).slice(0, 30000));
              }}
            />
          </label>
          <Field label="谁知道这些事？">
            <div className="check-list">
              {chars
                ?.filter((c) =>
                  members?.some((m) => m.worldId === worldId && m.characterId === c.id),
                )
                .map((c) => (
                  <label key={c.id}>
                    <input
                      type="checkbox"
                      checked={knowledgeOwners.includes(c.id)}
                      onChange={(e) =>
                        setKnowledgeOwners(
                          e.target.checked
                            ? [...knowledgeOwners, c.id]
                            : knowledgeOwners.filter((id) => id !== c.id),
                        )
                      }
                    />
                    {c.name}
                  </label>
                ))}
            </div>
          </Field>
          <Button
            variant="primary"
            disabled={!knowledge.trim() || !knowledgeOwners.length}
            onClick={async () => {
              const chunks = knowledge.match(/[\s\S]{1,1500}/g) ?? [];
              await db.memories.bulkAdd(
                chunks.map((content) => ({
                  id: uid('knowledge'),
                  worldId,
                  owners: knowledgeOwners,
                  content,
                  keywords: [],
                  importance: 0.9,
                  at: 0,
                  kind: 'knowledge' as const,
                })),
              );
              setKnowledge('');
              setShowKnowledge(false);
            }}
          >
            保存知识
          </Button>
        </Modal>
      )}
      {editCharacter !== undefined && (
        <CharacterEditor
          character={editCharacter ?? undefined}
          worldId={worldId}
          onClose={() => setEditCharacter(undefined)}
        />
      )}
      {packagePreview && (
        <Modal title="导入世界观预览" onClose={() => setPackagePreview(undefined)}>
          <h3>{packagePreview.world.name}</h3>
          <p>
            {packagePreview.characters.length} 位角色 · {packagePreview.groups.length} 个团体 ·{' '}
            {packagePreview.relationships.length} 条关系
          </p>
          <p>{packagePreview.characters.map((c) => c.name).join('、')}</p>
          <p className="muted">新建独立世界与角色资料，保留现有世界。聊天、密钥和历史不会导入。</p>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                const id = await importWorld(packagePreview);
                onSelect(id);
                setPackagePreview(undefined);
              } catch (e) {
                setPageError(String(e));
              }
            }}
          >
            确认导入并观察
          </Button>
        </Modal>
      )}
      {outsideCandidate && (
        <Confirm
          title="同时加入当前世界观？"
          confirmLabel="确认同时加入"
          onClose={() => setOutsideCandidate(undefined)}
          onConfirm={() => {
            setParticipants([...participants, outsideCandidate.id]);
            setConfirmedOutside([...confirmedOutside, outsideCandidate.id]);
            setOutsideCandidate(undefined);
          }}
        >
          <p>
            「{outsideCandidate.name}
            」还不在当前世界。保存团体时，该角色会同时加入当前世界观，保留原有世界和团体身份。
          </p>
        </Confirm>
      )}
    </div>
  );
}
