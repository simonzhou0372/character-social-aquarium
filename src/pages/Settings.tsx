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
} from 'lucide-react';
import { db } from '../data/db';
import { CompatibleProvider, setSessionKey, validateEndpoint, getKey } from '../ai/provider';
import { type ApiProfile, type Backup, ProfileSchema } from '../core/types';
import { exportBackup, importBackup, validateBackup, downloadJson } from '../data/backup';
import { Button, Input, Select, Field, Toggle, Status, Confirm, Textarea } from '../components/ui';
import { PromptManager } from './PromptManager';
import { TimeControls } from '../components/TimeControls';
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
        await client.complete([{ role: 'user', content: 'Reply OK.' }]);
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
        <Field
          label="上下文输入预算（估算 Token）"
          hint="优先保留世界事实、全局禁用规则、当前状态与最新用户消息；压缩旧聊天、低相关记忆和外观数据。必要事实超过预算时会明确提示，不会静默删除。"
        >
          <Input
            aria-label="上下文输入预算"
            type="number"
            min={1000}
            max={32000}
            step={500}
            value={p.contextBudgetTokens ?? 4000}
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
      <p className="muted">活跃度影响社交机会；角色的忙碌、睡眠与手机习惯仍然独立生效。</p>
      <div className="activity-presets">
        {(['quiet', 'standard', 'lively'] as const).map((v, i) => (
          <button
            key={v}
            className={s.activity === v ? 'selected' : ''}
            onClick={() => db.settings.update('app', { activity: v })}
          >
            <b>{['☾', '◒', '☀'][i]}</b>
            <strong>{['安静', '标准', '热闹'][i]}</strong>
            <span>{['让沉默也有位置', '刚刚好的日常', '多一些相遇'][i]}</span>
          </button>
        ))}
      </div>
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
                    void db.settings.update('app', { [k]: v });
                }}
              />
            </Field>
          ))}
        </div>
      </details>
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
export function Settings({ initialTab = 'api' }: { initialTab?: string }) {
  const [tab, setTab] = useState(initialTab);
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
          ['prompts', '提示词管理', BookOpen],
          ['simulation', '模拟器', Sliders],
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
                估算 {lastContext.context.beforeTokens} → {lastContext.context.afterTokens} Token ·
                输入预算 {lastContext.context.budgetTokens}
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
              <small>为六类 AI 任务设定独立的全局规则</small>
            </span>
            <span>→</span>
          </button>
        </>
      )}
      {tab === 'prompts' && <PromptManager />}
      {tab === 'simulation' && <SimulationSettings />}
      {tab === 'data' && <DataSettings />}
    </div>
  );
}
