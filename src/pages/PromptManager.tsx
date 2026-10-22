import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Save, RotateCcw, Download, Upload, Sparkles, ChevronDown } from 'lucide-react';
import { db } from '../data/db';
import {
  promptDefinitions,
  promptKeys,
  defaultPrompts,
  defaultRules,
  getPrompts,
  savePrompt,
  saveRules,
  replacePrompts,
  PromptConfigSchema,
  estimateTokens,
  type PromptEntry,
  type PromptKey,
  type MessageRules,
} from '../ai/prompts';
import { Button, Textarea, Toggle, Confirm, Status, Field, Input } from '../components/ui';
import { downloadJson } from '../data/backup';
function PromptCard({ entry, onError }: { entry: PromptEntry; onError: (s: string) => void }) {
  const [content, setContent] = useState(entry.content),
    [enabled, setEnabled] = useState(entry.enabled),
    [reset, setReset] = useState(false),
    [saved, setSaved] = useState(false);
  const d = promptDefinitions[entry.key];
  useEffect(() => {
    setContent(entry.content);
    setEnabled(entry.enabled);
  }, [entry.content, entry.enabled]);
  const dirty = content !== entry.content || enabled !== entry.enabled;
  async function save() {
    try {
      await savePrompt(db, entry.key, content, enabled);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      onError(String(e));
    }
  }
  return (
    <article className="prompt-card">
      <header>
        <span className="prompt-number">
          {String(promptKeys.indexOf(entry.key) + 1).padStart(2, '0')}
        </span>
        <div>
          <h3>{d.name}</h3>
          <p>{d.description}</p>
        </div>
        <Toggle label="启用" checked={enabled} onChange={setEnabled} />
      </header>
      <Textarea
        aria-label={d.name}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        maxLength={30000}
        rows={12}
      />
      <div className="prompt-meta">
        <span>
          {Array.from(content).length.toLocaleString()} 字符 · 约{' '}
          {estimateTokens(content).toLocaleString()} Token
        </span>
        <span>
          {entry.customized ? '自定义' : '默认'} ·{' '}
          {new Date(entry.updatedAt).toLocaleString('zh-CN')}
        </span>
      </div>
      <footer>
        <Button variant="ghost" onClick={() => setReset(true)}>
          <RotateCcw size={15} />
          恢复默认
        </Button>
        <Button variant={dirty ? 'primary' : 'default'} onClick={save} disabled={!dirty}>
          <Save size={15} />
          {saved ? '已保存' : '保存修改'}
        </Button>
      </footer>
      {reset && (
        <Confirm
          title={`恢复默认：${d.name}`}
          onClose={() => setReset(false)}
          onConfirm={() => {
            void savePrompt(db, entry.key, d.content, true, true).catch((e) => onError(String(e)));
            setReset(false);
          }}
        >
          <p>将覆盖本分类已保存的自定义内容和未保存修改。其他分类保持当前设置。</p>
          <strong>默认提示词预览</strong>
          <pre className="prompt-preview">{d.content}</pre>
        </Confirm>
      )}
    </article>
  );
}
function RulesEditor({
  initial,
  onError,
}: {
  initial: MessageRules;
  onError: (s: string) => void;
}) {
  const [rules, setRules] = useState(initial),
    [saved, setSaved] = useState(false);
  useEffect(() => setRules(initial), [initial]);
  const patch = <K extends keyof MessageRules>(k: K, v: MessageRules[K]) =>
    setRules((r) => ({ ...r, [k]: v }));
  const toggles: [keyof MessageRules, string][] = [
    ['allowMarkdown', '允许 Markdown'],
    ['allowActions', '允许动作描写'],
    ['allowThoughts', '允许角色心理描写'],
    ['allowEnd', '允许主动结束话题'],
    ['allowConsecutive', '允许连续发送多条消息'],
    ['allowSilence', '允许已读不回'],
    ['autonomous', '角色自主主动聊天'],
  ];
  return (
    <section className="panel rules-panel">
      <div className="section-title">
        <div>
          <h3>消息生成规则</h3>
          <p>长度建议保持自然，硬上限由程序强制检查。</p>
        </div>
        <span className="tag">GLOBAL DEFAULTS</span>
      </div>
      <div className="form-grid">
        {(
          [
            ['minMessages', '单次最少条数', 1, 3],
            ['maxMessages', '单次最多条数', 1, 3],
            ['suggestedMin', '建议最短字数', 0, 500],
            ['suggestedMax', '建议最长字数', 1, 500],
            ['hardLimit', '单条消息硬上限', 1, 2000],
          ] as const
        ).map(([key, label, min, max]) => (
          <Field key={key} label={label}>
            <Input
              type="number"
              min={min}
              max={max}
              value={rules[key]}
              onChange={(e) => patch(key, Number(e.target.value))}
            />
          </Field>
        ))}
      </div>
      <div className="rules-toggles">
        {toggles.map(([key, label]) => (
          <Toggle
            key={key}
            label={label}
            checked={rules[key] as boolean}
            onChange={(v) => patch(key, v)}
          />
        ))}
      </div>
      <p className="muted">
        关闭连续发送时，每批最多一条；允许已读不回时可以返回空消息数组。建议范围不强制最短长度。
      </p>
      <Button
        variant="primary"
        onClick={async () => {
          try {
            await saveRules(db, rules);
            setSaved(true);
          } catch {
            onError('请检查范围：最少条数 ≤ 最多条数，建议最短 ≤ 建议最长 ≤ 硬上限。');
          }
        }}
      >
        <Save size={16} />
        {saved ? '规则已保存' : '保存生成规则'}
      </Button>
    </section>
  );
}
export function PromptManager() {
  const config = useLiveQuery(() => db.promptConfigs.get('global'), []);
  useEffect(() => {
    void getPrompts(db);
  }, []);
  const [error, setError] = useState(''),
    [resetAll, setResetAll] = useState(false),
    [imported, setImported] = useState<unknown>(),
    [success, setSuccess] = useState('');
  return (
    <div className="prompt-manager">
      <div className="settings-heading">
        <div>
          <span className="eyebrow">GLOBAL PROMPT MANAGER</span>
          <h2>把交流的分寸，交给你。</h2>
          <p>六种任务，六份规则。每个新请求立即生效，正在执行的批次保持原有快照。</p>
        </div>
        <Sparkles size={32} />
      </div>
      <div className="toolbar">
        <Button
          onClick={() =>
            config &&
            downloadJson(
              { format: 'aquarium-prompts', version: 1, config },
              'aquarium-prompts.json',
            )
          }
        >
          <Download size={16} />
          导出提示词
        </Button>
        <label className="button">
          <Upload size={16} />
          导入提示词
          <input
            type="file"
            accept=".json,application/json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                if (f.size > 500000) throw new Error('文件过大');
                const data = JSON.parse(await f.text());
                if (data.format !== 'aquarium-prompts' || data.version !== 1)
                  throw new Error('备份格式不支持');
                setImported(PromptConfigSchema.parse(data.config));
              } catch {
                setError('提示词文件无效，请导入本应用导出的 JSON。');
              }
              e.target.value = '';
            }}
          />
        </label>
        <Button variant="ghost" onClick={() => setResetAll(true)}>
          <RotateCcw size={16} />
          恢复全部默认
        </Button>
        <span className="version-pill">配置版本 v{config?.version ?? 1}</span>
      </div>
      {error && (
        <Status error>
          {error}
          <button onClick={() => setError('')} className="text-button">
            关闭
          </button>
        </Status>
      )}
      {success && <Status>{success}</Status>}
      <div className="prompt-priority">
        <span>事实与硬性校验</span>
        <ChevronDown size={14} />
        <span>全局任务规范</span>
        <ChevronDown size={14} />
        <span>角色个人风格</span>
      </div>
      <div className="prompt-grid">
        {config?.entries.map((entry) => (
          <PromptCard key={entry.key} entry={entry} onError={setError} />
        ))}
      </div>
      {config && <RulesEditor initial={config.rules} onError={setError} />}
      <p className="local-note">
        保存在当前浏览器的本地数据库中。只有执行相关 AI
        任务时，启用的提示词才会发送到你选择的模型接口。
      </p>
      {resetAll && (
        <Confirm
          title="恢复全部默认提示词与生成规则？"
          onClose={() => setResetAll(false)}
          onConfirm={async () => {
            await replacePrompts(db, defaultPrompts());
            setResetAll(false);
            setSuccess('已恢复六类默认提示词与消息生成规则。');
          }}
        >
          <p>这将覆盖六类自定义提示词及生成规则。建议先导出一份备份。</p>
          <details>
            <summary>预览全部默认提示词</summary>
            {promptKeys.map((k) => (
              <div key={k}>
                <h4>{promptDefinitions[k].name}</h4>
                <pre className="prompt-preview">{promptDefinitions[k].content}</pre>
              </div>
            ))}
            <pre className="prompt-preview">{JSON.stringify(defaultRules, null, 2)}</pre>
          </details>
        </Confirm>
      )}
      {imported !== undefined && (
        <Confirm
          title="导入并替换全局提示词？"
          onClose={() => setImported(undefined)}
          onConfirm={async () => {
            await replacePrompts(db, imported);
            setImported(undefined);
            setSuccess('提示词导入完成，后续请求采用新版本。');
          }}
        >
          <p>将替换当前六类提示词和生成规则，已有聊天及事件不会被改写。</p>
          <pre className="prompt-preview">
            {(imported as { entries: PromptEntry[] }).entries
              .map(
                (e) =>
                  `${promptDefinitions[e.key as PromptKey].name} · ${e.enabled ? '启用' : '停用'}\n${e.content}`,
              )
              .join('\n\n')}
          </pre>
        </Confirm>
      )}
    </div>
  );
}
