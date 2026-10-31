import { UsageAnalysis } from '../components/UsageAnalysis';
import { budgetedCompletion } from '../ai/orchestrator';
import { getPrompts } from '../ai/prompts';
import { GenerationPerformance } from '../components/GenerationPerformance';
import { DEFAULT_CONTEXT_BUDGET_TOKENS, MAX_CONTEXT_BUDGET_TOKENS } from '../core/ai-limits';
import { TouhouPortraitEntry } from '../components/TouhouPortraitManager';
import { ObservationManager } from '../components/ObservationManager';
import { AvatarUpload } from '../components/AvatarUpload';
import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Plug,
  Sliders,
  Database,
  BookOpen,
  CheckCircle,
  Download,
  Upload,
  KeyRound,
  EyeOff,
  Sparkles,
  Gamepad2,
  Monitor,
  Palette,
} from 'lucide-react';
import { db } from '../data/db';
import { CompatibleProvider, setSessionKey, validateEndpoint, getKey } from '../ai/provider';
import { type ApiProfile, type Backup, ProfileSchema } from '../core/types';
import { exportBackup, importBackup, validateBackup, downloadJson } from '../data/backup';
import { Button, Input, Select, Field, Toggle, Status, Confirm, Textarea } from '../components/ui';
import { PromptManager } from './PromptManager';
import { TimeControls } from '../components/TimeControls';
import { activityModes } from '../core/activity';
const baseProfile: ApiProfile = {
  id: 'api',
  provider: '自定义兼容接口',
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  persistKey: false,
  status: 'untested',
};
export function ApiSettings({ onDone }: { onDone?: () => void }) {
  const stored = useLiveQuery(() => db.profiles.get('api'), []);
  const [p, setP] = useState(baseProfile),
    [key, setKey] = useState(''),
    [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    if (stored) {
      setP(stored);
      setKey(getKey(stored));
    }
  }, [stored]);
  const patch = (v: Partial<ApiProfile>) => setP((s) => ({ ...s, ...v }));
  async function test() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const parsed = ProfileSchema.parse({ ...p, model: p.model.trim() || 'model-list' });
      validateEndpoint(parsed.baseUrl);
      const client = new CompatibleProvider(parsed, key || stored?.key || '');
      if (!p.model.trim()) {
        const list = await client.models();
        setModels(list);
        setNotice('已获取模型列表，请选择模型后测试连接。');
      } else {
        await budgetedCompletion(
          db,
          client,
          [{ role: 'user', content: 'Reply OK.' }],
          (await db.settings.get('app'))?.worldId ?? 'global',
          'connection',
          await getPrompts(db),
          undefined,
          { outputBudget: 32 },
        );
        patch({ status: 'connected' });
        setNotice('连接成功，可以使用角色 AI 功能。');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '连接失败');
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    try {
      if (!key.trim() && !stored?.key) throw new Error('请先填写 API Key。');
      ProfileSchema.parse(p);
      validateEndpoint(p.baseUrl);
      setSessionKey(key || stored?.key || '');
      await db.profiles.put({ ...p, key: p.persistKey ? key || stored?.key : undefined });
      setNotice('配置已保存。');
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : '配置无效');
    }
  }
  return (
    <section className="panel api-panel">
      <div className="section-title">
        <div>
          <span className="eyebrow">CONNECT YOUR WORLD</span>
          <h2>给这个世界，一点想象力。</h2>
          <p>连接支持 Chat Completions 的接口，让角色开始真实交流。</p>
        </div>
        <Plug size={30} />
      </div>
      <div className="form-grid">
        <Field label="服务商">
          <Select
            value={p.provider}
            onChange={(e) => {
              const v = e.target.value;
              patch({
                provider: v,
                baseUrl:
                  v === 'OpenAI'
                    ? 'https://api.openai.com/v1'
                    : v === 'DeepSeek'
                      ? 'https://api.deepseek.com/v1'
                      : p.baseUrl,
                status: 'untested',
              });
            }}
          >
            <option>自定义兼容接口</option>
            <option>OpenAI</option>
            <option>DeepSeek</option>
            <option>本地模型 / 代理</option>
          </Select>
        </Field>
        <Field label="模型名称" hint="填写服务商提供的模型 ID，或留空点击测试来获取列表。">
          <Input
            aria-label="模型名称"
            list="models"
            value={p.model}
            onChange={(e) => patch({ model: e.target.value, status: 'untested' })}
          />
          <datalist id="models">
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </datalist>
        </Field>
      </div>
      <Field label="API Key">
        <Input
          aria-label="API Key"
          type="password"
          autoComplete="off"
          placeholder="密钥仅发往你指定的模型接口"
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            patch({ status: 'untested' });
          }}
        />
      </Field>
      <details
        className="advanced"
        open={p.provider === '自定义兼容接口' || p.provider === '本地模型 / 代理'}
      >
        <summary>高级连接设置</summary>
        <Field label="API Base URL" hint="包含 /v1 等接口前缀，不包含 /chat/completions。">
          <Input
            aria-label="API Base URL"
            type="url"
            value={p.baseUrl}
            onChange={(e) => patch({ baseUrl: e.target.value, status: 'untested' })}
          />
        </Field>
        <Field label="结构化输出模式">
          <Select
            value={p.structuredOutputMode ?? 'auto'}
            onChange={(e) =>
              patch({ structuredOutputMode: e.target.value as 'auto' | 'json' | 'off' })
            }
          >
            <option value="auto">自动兼容（未知接口使用JSON文本）</option>
            <option value="json">服务商 JSON 模式</option>
            <option value="off">兼容 JSON 文本模式</option>
          </Select>
        </Field>
        <Field
          label="上下文输入预算（估算 Token）"
          hint="默认 32,000，上限可设为 1,000,000 Token；这是输入额度而非填充目标，仍会压缩无关历史。请按服务商实际模型窗口设置，并为输出及模型思考留出余量。更高额度可能增加费用；已有手动设置保持不变。"
        >
          <Input
            aria-label="上下文输入预算"
            type="number"
            min={1000}
            max={MAX_CONTEXT_BUDGET_TOKENS}
            step={500}
            value={p.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS}
            onChange={(e) => patch({ contextBudgetTokens: Number(e.target.value) })}
          />
        </Field>
        <Field
          label="单次输出预算（Token）"
          hint="输出预算与上下文输入预算分开。截断时最多重试一次，使用更紧凑上下文及有限的更高输出额度。"
        >
          <Input
            aria-label="单次输出预算"
            type="number"
            min={256}
            max={16000}
            step={256}
            value={p.outputBudgetTokens ?? 2048}
            onChange={(e) => patch({ outputBudgetTokens: Number(e.target.value) })}
          />
        </Field>
        <Field label="模型深度思考">
          <Select
            value={p.thinkingMode ?? 'auto'}
            onChange={(e) => patch({ thinkingMode: e.target.value as ApiProfile['thinkingMode'] })}
          >
            <option value="auto">自动：日常 DeepSeek 任务关闭深度思考</option>
            <option value="off">关闭（仅支持此参数的接口）</option>
            <option value="on">保留模型默认设置</option>
          </Select>
        </Field>
      </details>
      <Toggle
        label="在此浏览器保存密钥"
        checked={p.persistKey}
        onChange={(v) => patch({ persistKey: v })}
      />
      <div className="key-note">
        <EyeOff size={18} />
        <p>
          默认仅保留在当前会话内。选择保存后，密钥以可被本机脚本读取的形式存于
          IndexedDB，不是加密保险箱。普通备份不含密钥。部分服务商限制浏览器跨域访问。
        </p>
      </div>
      {notice && <Status>{notice}</Status>}
      {error && <Status error>{error}</Status>}
      <div className="toolbar">
        <Button onClick={test} disabled={busy}>
          <Plug size={16} />
          {busy ? '正在连接…' : '测试连接'}
        </Button>
        <Button variant="primary" onClick={save}>
          <KeyRound size={16} />
          保存配置
        </Button>
      </div>
    </section>
  );
}
function SimulationSettings() {
  const s = useLiveQuery(() => db.settings.get('app'), []);
  const [notice, setNotice] = useState('');
  const [unlimited, setUnlimited] = useState(false);
  useEffect(() => setUnlimited(s?.unlimitedUsage ?? false), [s?.unlimitedUsage]);
  if (!s) return null;
  return (
    <section className="panel">
      <h2>让日常按自己的节奏发生。</h2>
      <Field label="线下观察默认阅读模式">
        <Select
          value={s.sceneReadingMode ?? 'stage'}
          onChange={(e) =>
            void db.settings.update('app', {
              sceneReadingMode: e.target.value as 'stage' | 'archive',
            })
          }
        >
          <option value="stage">演出模式</option>
          <option value="archive">完整记录</option>
        </Select>
      </Field>
      <p className="muted">活跃度影响社交机会；角色的忙碌、睡眠与手机习惯仍然独立生效。</p>
      <div className="activity-presets game-activity-presets">
        {activityModes.map((item) => (
          <button
            key={item.mode}
            data-activity={item.mode}
            aria-pressed={s.activity === item.mode}
            className={`${s.activity === item.mode ? 'selected' : ''} activity-level-${item.level}`}
            onClick={() => {
              setNotice(`已切换到「${item.label}」，后续模拟机会立即采用，不会改写已有记录。`);
              void db.settings.update('app', { activity: item.mode });
            }}
          >
            <span className="activity-gauge" aria-hidden="true">
              {Array.from({ length: 5 }, (_, i) => (
                <i key={i} className={i < item.level ? 'on' : ''} />
              ))}
            </span>
            <b>{item.glyph}</b>
            <strong>{item.label}</strong>
            <span>{item.short}</span>
            <small>{item.description}</small>
            {s.activity === item.mode && <em>ACTIVE</em>}
          </button>
        ))}
      </div>
      <p className="activity-selected-note">
        {activityModes.find((x) => x.mode === s.activity)?.description}
      </p>
      <p className="muted">
        用户昵称、头像与身份已统一收纳到「用户资料」。世界内的速度与时间也可从顶部控制。
      </p>
      <Field label="线下事件抽样生成比例（独立于网聊活跃度）">
        <Input
          type="range"
          min="0"
          max="1"
          step=".1"
          value={s.sceneFrequency ?? 0.5}
          onChange={(e) =>
            void db.settings.update('app', { sceneFrequency: Number(e.target.value) })
          }
        />
        <span>{Math.round((s.sceneFrequency ?? 0.5) * 100)}%</span>
      </Field>
      <Field label="每个世界每天最多生成线下场景">
        <Input
          type="number"
          min="0"
          max="100"
          value={s.sceneDailyBudget ?? 3}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isInteger(v) && v >= 0 && v <= 100)
              void db.settings.update('app', { sceneDailyBudget: v });
          }}
        />
      </Field>
      <Field
        label="线上聊天中的线下互动入口"
        hint="默认最积极：群聊里只要有一位成员参与了线下事件就显示；私聊始终要求双方都参与（三人以上事件只要两人都在场也显示）。"
      >
        <Select
          value={s.sceneLinkMode ?? 'all'}
          onChange={(e) =>
            void db.settings.update('app', {
              sceneLinkMode: e.target.value as 'all' | 'mutual' | 'off',
            })
          }
        >
          <option value="all">最积极（推荐）· 群聊任一人参与即显示</option>
          <option value="mutual">仅共同参与 · 会话全员都在场才显示</option>
          <option value="off">关闭 · 不在聊天里插入线下入口</option>
        </Select>
      </Field>
      <Toggle
        checked={unlimited}
        onChange={(unlimitedUsage) => {
          setUnlimited(unlimitedUsage);
          void db.settings.update('app', { unlimitedUsage }).catch((e) => {
            setUnlimited(s.unlimitedUsage ?? false);
            setNotice(String(e));
          });
        }}
        label="不限制模型用量"
      />
      {s.unlimitedUsage && (
        <Status>
          不限制应用内部的模型请求和 Token 总预算，可能产生较高 API
          费用。服务商自身限额仍然有效。并发、重试和独立场景密度保护继续生效。
        </Status>
      )}
      <details className="advanced">
        <summary>用量与时间高级设置</summary>
        <div className="form-grid">
          {(
            [
              ['dailyRequests', '每日最多 API 请求', 1, 5000],
              ['dailyTokens', '每日 Token 预算', 1000, 10000000],
              ['dailyMessages', '每日最多生成消息', 1, 10000],
              ['recoveryBudget', '单次补全请求预算', 1, 200],
            ] as const
          ).map(([k, label, min, max]) => (
            <Field key={k} label={label}>
              <Input
                type="number"
                min={min}
                max={max}
                value={s[k]}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isInteger(v) && v >= min && v <= max)
                    void db.settings
                      .where('id')
                      .equals('app')
                      .modify((row) => {
                        row[k] = v;
                      });
                }}
              />
            </Field>
          ))}
        </div>
      </details>
      <GenerationPerformance worldId={s.worldId} />
      <TimeControls worldId={s.worldId} />
      {notice && <Status>{notice}</Status>}
    </section>
  );
}
function DataSettings() {
  const counts = useLiveQuery(
    async () => ({
      characters: await db.characters.count(),
      messages: await db.messages.count(),
      events: await db.events.count(),
    }),
    [],
  );
  const [preview, setPreview] = useState<Backup>(),
    [error, setError] = useState(''),
    [success, setSuccess] = useState('');
  return (
    <section className="panel">
      <div className="section-title">
        <div>
          <h2>把这些日常，好好收藏。</h2>
          <p>你的世界、角色、头像、消息与提示词都留在当前浏览器。</p>
        </div>
        <Database size={30} />
      </div>
      <TouhouPortraitEntry />
      <div className="data-stats">
        <span>
          <b>{counts?.characters ?? 0}</b> 位角色
        </span>
        <span>
          <b>{counts?.messages ?? 0}</b> 条消息
        </span>
        <span>
          <b>{counts?.events ?? 0}</b> 个事件
        </span>
      </div>
      <div className="toolbar">
        <Button
          variant="primary"
          onClick={async () =>
            downloadJson(
              await exportBackup(),
              `aquarium-backup-${new Date().toISOString().slice(0, 10)}.json`,
            )
          }
        >
          <Download size={16} />
          导出全部数据
        </Button>
        <label className="button">
          <Upload size={16} />
          从备份恢复
          <input
            hidden
            type="file"
            accept=".json"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                if (f.size > 100 * 1024 * 1024) throw new Error('文件超过 100 MB');
                setPreview(validateBackup(JSON.parse(await f.text())));
              } catch (err) {
                setError(err instanceof Error ? err.message : '备份格式不正确');
              }
              e.target.value = '';
            }}
          />
        </label>
        <Button
          onClick={async () => {
            const granted = await navigator.storage?.persist?.();
            setSuccess(
              granted ? '浏览器已授予持久存储。' : '浏览器暂未授予持久存储，请定期导出备份。',
            );
          }}
        >
          申请持久存储
        </Button>
      </div>
      <p className="muted">
        备份不包含 API 密钥。清理浏览器站点数据会删除本地世界；换设备前请导出备份。
      </p>
      {error && <Status error>{error}</Status>}
      {success && <Status>{success}</Status>}
      {preview && (
        <Confirm
          title="恢复备份并替换当前数据？"
          onClose={() => setPreview(undefined)}
          onConfirm={async () => {
            try {
              await importBackup(preview);
              setPreview(undefined);
              setSuccess('恢复成功，模拟已暂停，请重新配置 API 后继续。');
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          <p>
            备份包含 {preview.worlds.length} 个世界、{preview.characters.length} 位角色、
            {preview.messages.length} 条消息、{preview.events.length} 个事件。
          </p>
          <p>
            冲突策略：完整替换当前本地数据。当前未导出的内容将被覆盖，API
            配置会清除。建议先导出当前数据。
          </p>
        </Confirm>
      )}
    </section>
  );
}
function AppearanceSettings() {
  const s = useLiveQuery(() => db.settings.get('app'), []);
  if (!s) return null;
  const levels = [
    ['off', '关闭', '只保留瞬时状态变化，不播放装饰动效。'],
    ['low', '低', '减少背景运动、视差与粒子，保留必要反馈。'],
    ['standard', '标准', '推荐等级，兼顾氛围、帧率与阅读体验。'],
    ['high', '高', '完整转场、背景层次与事件演出，适合性能充足的设备。'],
  ] as const;
  return (
    <div className="appearance-settings">
      <section className="panel appearance-panel">
        <div className="section-title">
          <div>
            <span className="eyebrow">INTERFACE ARCHIVE / 界面版本</span>
            <h2>选择进入世界的方式。</h2>
            <p>随时可以切回经典界面；世界、聊天与模拟数据不会被转换或重写。</p>
          </div>
          <Palette size={30} />
        </div>
        <div className="ui-mode-picker">
          <button
            className={s.uiMode !== 'classic' ? 'selected' : ''}
            aria-pressed={s.uiMode !== 'classic'}
            onClick={() => void db.settings.update('app', { uiMode: 'game' })}
          >
            <span className="ui-mode-preview preview-game" aria-hidden="true">
              <i />
              <i />
              <b>HUD</b>
            </span>
            <strong>
              <Gamepad2 size={16} /> 游戏界面
            </strong>
            <span>沉浸式世界 HUD、角色舞台、转场与事件演出。</span>
            {s.uiMode !== 'classic' && <em>当前使用</em>}
          </button>
          <button
            className={s.uiMode === 'classic' ? 'selected' : ''}
            aria-pressed={s.uiMode === 'classic'}
            onClick={() => void db.settings.update('app', { uiMode: 'classic' })}
          >
            <span className="ui-mode-preview preview-classic" aria-hidden="true">
              <i />
              <i />
              <b>WEB</b>
            </span>
            <strong>
              <Monitor size={16} /> 经典界面
            </strong>
            <span>保留重构前的观察池排版与数据管理节奏。</span>
            {s.uiMode === 'classic' && <em>当前使用</em>}
          </button>
        </div>
      </section>
      <section className="panel appearance-panel">
        <div className="section-title">
          <div>
            <h2>视觉效果等级</h2>
            <p>动效不会阻塞世界模拟。低性能设备和减少动态偏好会自动降低装饰强度。</p>
          </div>
          <Sparkles size={26} />
        </div>
        <div className="motion-levels" role="radiogroup" aria-label="视觉效果等级">
          {levels.map(([value, label, desc], i) => (
            <button
              key={value}
              role="radio"
              aria-checked={(s.motionLevel ?? 'standard') === value}
              className={(s.motionLevel ?? 'standard') === value ? 'selected' : ''}
              onClick={() => void db.settings.update('app', { motionLevel: value })}
            >
              <span className="motion-bars" aria-hidden="true">
                {[0, 1, 2, 3].map((n) => (
                  <i key={n} className={n <= i ? 'on' : ''} />
                ))}
              </span>
              <strong>{label}</strong>
              <small>{desc}</small>
            </button>
          ))}
        </div>
        <div className="motion-note">
          <span>PREFERS-REDUCED-MOTION</span>
          <p>
            系统开启“减少动态效果”时，背景漂移、粒子与大幅转场会自动降级；暂停、未读和重大事件仍有明确的静态提示。
          </p>
        </div>
      </section>
    </div>
  );
}
function UserSettings() {
  const s = useLiveQuery(() => db.settings.get('app'), []);
  if (!s) return null;
  return (
    <section className="panel">
      <h2>用户资料</h2>{' '}
      <Field label="你的头像">
        <AvatarUpload
          value={s.userAvatar}
          name={s.nickname}
          onChange={(userAvatar) => void db.settings.update('app', { userAvatar })}
        />
      </Field>
      <Field label="你的昵称">
        <Input
          value={s.nickname}
          maxLength={40}
          onChange={(e) =>
            e.target.value && db.settings.update('app', { nickname: e.target.value })
          }
        />
      </Field>
      <Field label="你在世界中的身份">
        <Textarea
          value={s.userBio}
          onChange={(e) => db.settings.update('app', { userBio: e.target.value })}
        />
      </Field>
    </section>
  );
}
export function Settings({ initialTab = 'api' }: { initialTab?: string }) {
  const [tab, setTab] = useState(initialTab);
  const activeWorld = useLiveQuery(() => db.settings.get('app'), []);
  const usage = useLiveQuery(() => db.usage.toArray(), []);
  const lastContext = useLiveQuery(
    () =>
      db.taskLogs
        .orderBy('at')
        .reverse()
        .filter((log) => !!log.context)
        .first(),
    [],
  );
  const total = usage?.reduce(
    (a, u) => ({
      requests: a.requests + u.requests,
      tokens: a.tokens + u.inputTokens + u.outputTokens,
    }),
    { requests: 0, tokens: 0 },
  );
  return (
    <div>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CONTROL ROOM / 设置</span>
          <h1>
            世界的控制室<span>✳</span>
          </h1>
          <p>调整一些规则，然后把生活交还给他们。</p>
        </div>
      </div>
      <div className="settings-tabs">
        {[
          ['api', 'AI 设置', Plug],
          ['usage', '用量分析', Sliders],
          ['prompts', '提示词管理', BookOpen],
          ['simulation', '模拟器', Sliders],
          ['appearance', '外观与动效', Sparkles],
          ['observation', '观察管理', EyeOff],
          ['profile', '用户资料', Sliders],
          ['data', '本地数据', Database],
        ].map(([key, title, Icon]) => (
          <button
            key={String(key)}
            className={tab === key ? 'active' : ''}
            onClick={() => setTab(String(key))}
          >
            {typeof Icon !== 'string' && <Icon size={17} />}
            <span>{String(title)}</span>
          </button>
        ))}
      </div>
      <div className="settings-panel" key={tab}>
        {tab === 'api' && (
          <>
            <ApiSettings />
            <div className="usage-strip">
              <CheckCircle size={18} />
              <span>
                累计 {total?.requests ?? 0} 次请求 · {(total?.tokens ?? 0).toLocaleString()}{' '}
                Token（缺少服务商统计时按估算记录）
              </span>
            </div>
            {lastContext?.context && (
              <div className="panel context-report">
                <h3>最近请求的上下文取舍</h3>
                <p>
                  估算 {lastContext.context.beforeTokens} → {lastContext.context.afterTokens} Token
                  · 输入预算 {lastContext.context.budgetTokens}
                </p>
                <p>
                  省略 {lastContext.context.removedHistory} 条旧消息、
                  {lastContext.context.removedMemories}{' '}
                  条低优先级记忆；保留世界事实、全局规则与最新消息。
                </p>
                <small>
                  来源任务：{lastContext.task} ·{' '}
                  {lastContext.finishReason === 'length'
                    ? '上次输出截断，已尝试有限恢复'
                    : lastContext.status === 'completed'
                      ? '已完成'
                      : '进行中或未完成'}
                </small>
              </div>
            )}
            <button className="prompt-entry" onClick={() => setTab('prompts')}>
              <BookOpen size={22} />
              <span>
                <strong>提示词管理</strong>
                <small>为各类 AI 任务设定独立的全局规则</small>
              </span>
              <span>→</span>
            </button>
          </>
        )}
        {tab === 'usage' && <UsageAnalysis onObserve={() => setTab('observation')} />}
        {tab === 'prompts' && <PromptManager />}
        {tab === 'simulation' && <SimulationSettings />}
        {tab === 'appearance' && <AppearanceSettings />}
        {tab === 'profile' && <UserSettings />}
        {tab === 'data' && <DataSettings />}
        {tab === 'observation' && activeWorld && (
          <ObservationManager key={activeWorld.worldId} worldId={activeWorld.worldId} />
        )}
      </div>
    </div>
  );
}
