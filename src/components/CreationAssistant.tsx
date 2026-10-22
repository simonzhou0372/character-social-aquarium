import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { generateCreationDraft, type CreationDraft } from '../ai/drafts';
import { Button, Field, Textarea, Input, Status } from './ui';
export function CreationAssistant({
  kind,
  known,
  existingNames,
  onApply,
}: {
  kind: 'world' | 'group';
  known: unknown;
  existingNames: string[];
  onApply: (draft: CreationDraft) => void;
}) {
  const [constraints, setConstraints] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [draft, setDraft] = useState<CreationDraft>();
  return (
    <section className="creation-assistant">
      <div className="section-title">
        <h3>
          <Sparkles size={16} />
          AI 帮你搭起{kind === 'world' ? '整个世界' : '一个小圈子'}
        </h3>
        <span className="tag">先预览，再采用</span>
      </div>
      <Field
        label="AI 生成约束"
        hint="可填写人数、原作/AU、人物关系边界、日常基调与不希望出现的内容。会结合上方预填写内容，不修改现有角色。"
      >
        <Textarea
          rows={3}
          value={constraints}
          maxLength={5000}
          onChange={(e) => setConstraints(e.target.value)}
          placeholder={
            kind === 'world'
              ? '例如：现代海滨小镇，3 位原创成年角色，一个摄影社。没有超自然能力，不强行发展恋爱关系。'
              : '例如：以现有成员为基础创建乐队，再新增一位慢热的鼓手。轻松日常，不修改现有成员人设。'
          }
        />
      </Field>
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            setDraft(await generateCreationDraft(kind, known, constraints, existingNames));
          } catch (e) {
            setError(e instanceof Error ? e.message : '草稿生成失败');
          } finally {
            setBusy(false);
          }
        }}
      >
        <Sparkles size={16} />
        {busy
          ? '正在生成草稿…'
          : kind === 'world'
            ? '生成世界观、团体和角色草稿'
            : '生成团体和角色草稿'}
      </Button>
      {error && <Status error>{error}</Status>}
      {draft && (
        <div className="creation-draft">
          <Status>{draft.uncertain}</Status>
          {draft.world && (
            <>
              <h4>{draft.world.name}</h4>
              <p>{draft.world.description}</p>
              <p className="muted">{draft.world.rules}</p>
            </>
          )}
          {draft.characters.map((c, i) => (
            <details key={i} className="draft-character">
              <summary>{c.name} · 新角色</summary>
              <Field label="草稿角色名称">
                <Input
                  value={c.name}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      characters: draft.characters.map((x, j) =>
                        i === j ? { ...x, name: e.target.value } : x,
                      ),
                      groups: draft.groups.map((g) => ({
                        ...g,
                        memberNames: g.memberNames.map((n) => (n === c.name ? e.target.value : n)),
                      })),
                    })
                  }
                />
              </Field>
              {(['bio', 'personality', 'style', 'habits'] as const).map((k, index) => (
                <Field key={k} label={['简介', '性格', '口吻', '生活习惯'][index]}>
                  <Textarea
                    rows={2}
                    value={c[k]}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        characters: draft.characters.map((x, j) =>
                          i === j ? { ...x, [k]: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </Field>
              ))}
            </details>
          ))}
          {draft.groups.map((g, i) => (
            <div key={i} className="draft-group">
              <strong>{g.name}</strong>
              <p>{g.description}</p>
              <small>成员：{g.memberNames.join('、')}</small>
            </div>
          ))}
          <Button
            variant="primary"
            onClick={() => {
              onApply(draft);
              setDraft(undefined);
            }}
          >
            采用草稿并继续编辑
          </Button>
          <p className="muted">采用只填入当前表单，最后点击保存才会写入世界。</p>
        </div>
      )}
    </section>
  );
}
