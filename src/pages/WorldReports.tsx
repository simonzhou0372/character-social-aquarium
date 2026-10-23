import { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { reportTypes, reportNames, type ReportSource } from '../core/focus-types';
import { generateReport, configureReports, archiveReports } from '../core/reports';
import { emptyReports } from '../core/focus-types';
import { formatWorldTime, calendarDate } from '../core/calendar';
import { liveProvider } from '../ai/orchestrator';
import { Button, Field, Input, Select, Toggle, Modal, Status, Empty } from '../components/ui';
import { SceneDetail } from './Scenes';
export function WorldReports({
  worldId,
  onCharacter,
  onConversation,
  onEvent,
}: {
  worldId: string;
  onCharacter: (id: string) => void;
  onConversation: (id: string) => void;
  onEvent: (id: string) => void;
}) {
  const data = useLiveQuery(
    async () => ({
      worlds: await db.worlds.toArray(),
      reports: await db.worldReports.toArray(),
      chars: await db.characters.toArray(),
    }),
    [],
  );
  const [world, setWorld] = useState(worldId),
    [type, setType] = useState('all'),
    [date, setDate] = useState(''),
    [selected, setSelected] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [sceneId, setSceneId] = useState('');
  const [reportSettings, setReportSettings] = useState({ ...emptyReports });
  const scene = useLiveQuery(() => (sceneId ? db.scenes.get(sceneId) : undefined), [sceneId]);
  const w = data?.worlds.find((w) => w.id === world),
    report = data?.reports.find((r) => r.id === selected);
  useEffect(() => {
    setReportSettings(w?.reportSettings ?? { ...emptyReports });
  }, [world, JSON.stringify(w?.reportSettings)]);
  const rows =
    data?.reports
      .filter(
        (r) =>
          (!world || r.worldId === world) &&
          (type === 'all' || r.type === type) &&
          (!date ||
            calendarDate(data.worlds.find((w) => w.id === r.worldId)!, r.start).includes(date)),
      )
      .sort((a, b) => b.end - a.end) ?? [];
  async function generate(id: string, ai = false) {
    setBusy(true);
    setError('');
    try {
      await generateReport(id, db, ai ? await liveProvider() : undefined);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function openSource(source: ReportSource) {
    if (source.type === 'message' && source.conversationId) onConversation(source.conversationId);
    else if (source.type === 'scene') setSceneId(source.id);
    else if (source.type === 'event') onEvent(source.id);
    else if (source.characterIds[0]) onCharacter(source.characterIds[0]);
  }
  return (
    <div>
      <div className="page-heading">
        <div>
          <span className="eyebrow">WORLD REPORTS</span>
          <h1>把值得记住的日子收好</h1>
          <p>只整理已经发生的事实，不为报告制造新的故事。</p>
        </div>
      </div>
      <div className="toolbar">
        <Select aria-label="报告世界" value={world} onChange={(e) => setWorld(e.target.value)}>
          <option value="">全部世界</option>
          {data?.worlds.map((w) => (
            <option value={w.id} key={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
        <Select aria-label="报告类型" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="all">全部类型</option>
          {reportTypes.map((t) => (
            <option value={t} key={t}>
              {reportNames[t]}
            </option>
          ))}
        </Select>
        <Input
          aria-label="报告日期查找"
          placeholder="虚拟日期，如23456-01"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>
      {w && (
        <details className="panel">
          <summary>{w.name} · 定期报告开关</summary>
          <p>
            五种报告独立开启，按世界纪年归档；旧报告保留。久远周期先归档，打开后按需整理，不突发请求AI。
          </p>
          {reportTypes.map((t) => (
            <Toggle
              key={t}
              label={'启用' + reportNames[t]}
              checked={reportSettings[t]}
              onChange={(value) => {
                const next = { ...reportSettings, [t]: value };
                setReportSettings(next);
                void configureReports(w.id, next).catch((e) => setError(String(e)));
              }}
            />
          ))}
          <Button onClick={() => void archiveReports(w.id).catch((e) => setError(String(e)))}>
            检查已结束的周期
          </Button>
        </details>
      )}
      {error && <Status error>{error}</Status>}
      {!rows.length && (
        <Empty
          title="还没有周期报告"
          description="选择世界，开启需要的报告；世界跨过周期边界后自动归档。"
        />
      )}
      <div className="report-grid">
        {rows.slice(0, 200).map((r) => (
          <article
            className={'panel report-card ' + (r.type === 'yearly' ? 'annual-report' : '')}
            key={r.id}
          >
            <span className="eyebrow">{reportNames[r.type]}</span>
            <h3>{formatWorldTime(data!.worlds.find((w) => w.id === r.worldId)!, r.start)}</h3>
            <p>{r.overview}</p>
            <p>
              {r.status === 'ready'
                ? '已生成'
                : r.status === 'generating'
                  ? '生成中'
                  : r.status === 'failed'
                    ? '等待重试'
                    : '已归档，待生成'}
            </p>
            <Button
              onClick={() => {
                setSelected(r.id);
                if (r.status === 'pending') void generate(r.id);
              }}
            >
              查看报告
            </Button>
          </article>
        ))}
      </div>
      {rows.length > 200 && <p>展示最新200份；通过日期搜索查找更早归档。</p>}
      {report && (
        <Modal
          title={reportNames[report.type] + ' · 世界观察档案'}
          wide
          onClose={() => setSelected('')}
        >
          <p>
            {formatWorldTime(data!.worlds.find((w) => w.id === report.worldId)!, report.start)} —{' '}
            {formatWorldTime(data!.worlds.find((w) => w.id === report.worldId)!, report.end - 1)}
          </p>
          <p>{report.overview}</p>
          {error && <Status error>{error}</Status>}
          {report.error && <Status error>{report.error}</Status>}
          {report.sections.map((section, i) => (
            <section key={i}>
              <h3>{section.heading}</h3>
              {section.sourceIds.map((id) => {
                const s = report.sources.find((s) => s.id === id);
                return s ? (
                  <article className="report-source" key={id}>
                    <p>{s.label}</p>
                    <div className="toolbar">
                      {s.characterIds
                        .filter((id) => id !== 'user')
                        .map((id) => (
                          <Button key={id} onClick={() => onCharacter(id)}>
                            {data?.chars.find((c) => c.id === id)?.name ?? '人物'}
                          </Button>
                        ))}
                      <Button onClick={() => openSource(s)}>查看原始记录</Button>
                    </div>
                  </article>
                ) : null;
              })}
            </section>
          ))}
          <div className="toolbar">
            <Button disabled={busy} onClick={() => void generate(report.id)}>
              按已有事实整理 / 重试
            </Button>
            <Button disabled={busy} onClick={() => void generate(report.id, true)}>
              AI 整理事实结构
            </Button>
          </div>
          <small>
            AI只选择已有事实编号与章节，正文取自保存的原始记录；报告不会写入角色共同记忆。
          </small>
        </Modal>
      )}
      {scene && <SceneDetail scene={scene} onClose={() => setSceneId('')} />}
    </div>
  );
}
