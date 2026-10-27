import { RecycleBin } from './pages/RecycleBin';
import { maintainWorld } from './core/world-maintenance';
import { WorldReports } from './pages/WorldReports';
import { ObservationManager } from './components/ObservationManager';
import { MajorEvents, MajorBanner, MajorEventDetail } from './pages/MajorEvents';
import { drainContent } from './ai/content-queue';
import { foregroundStart, changeForeground } from './core/clock-presence';
import { settleClocks } from './core/time';
import { diagnostic } from './core/diagnostics';
import { formatWorldTime, worldTime } from './core/calendar';
import { WorldHUD } from './components/WorldHUD';
import { Scenes } from './pages/Scenes';
import { Component, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Waves,
  BookOpen,
  LayoutDashboard,
  Globe2,
  MessageCircle,
  ContactRound,
  Network,
  Clock3,
  Settings as SettingsIcon,
  Play,
  Pause,
  ChevronDown,
  Menu,
  X,
  ArrowUpRight,
  FlaskConical,
  AlertCircle,
  Sparkles,
  Radio,
  CalendarDays,
  ScanLine,
} from 'lucide-react';
import { db } from './data/db';
import { seed } from './data/seed';
import { runWorld, setRunning, type RecoveryProgress } from './core/engine';
import { getKey } from './ai/provider';
import { Avatar, Button, Modal, Select, Status } from './components/ui';
import { Home } from './pages/Home';
import { Characters, CharacterEditor } from './pages/Characters';
import { Worlds } from './pages/Worlds';
import { Relationships } from './pages/Relationships';
import { Timeline } from './pages/Timeline';
import { Chats } from './pages/Chats';
import { Settings, ApiSettings } from './pages/Settings';
import type { Character } from './core/types';
import { UIPreferencesProvider, type MotionLevel, type UIMode } from './components/ui-preferences';
const navigation = [
  { id: 'home', label: '今日观察', sub: 'OVERVIEW', icon: LayoutDashboard },
  { id: 'chats', label: '聊天消息', sub: 'MESSAGES', icon: MessageCircle },
  { id: 'scenes', label: '线下观察', sub: 'IN PERSON', icon: ContactRound },
  { id: 'majorEvents', label: '重大事件', sub: 'WORLD EVENTS', icon: Globe2 },
  { id: 'reports', label: '世界报告', sub: 'REPORTS', icon: BookOpen },
  { id: 'timeline', label: '生活时间轴', sub: 'LIFE LOG', icon: Clock3 },
  { id: 'worlds', label: '世界与团体', sub: 'WORLDS', icon: Globe2 },
  { id: 'relationships', label: '关系网络', sub: 'CONNECTIONS', icon: Network },
  { id: 'characters', label: '角色图鉴', sub: 'CHARACTERS', icon: ContactRound },
  { id: 'recycle', label: '回收站', sub: 'RECYCLE BIN', icon: Globe2 },
];
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  render() {
    return this.state.error ? (
      <div className="fatal-error">
        <h1>界面遇到了一点问题</h1>
        <p>已经保存的本地数据仍然保留。</p>
        <pre>{this.state.error}</pre>
        <Button onClick={() => location.reload()}>重新打开</Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
export default function App() {
  const [ready, setReady] = useState(false),
    [startupError, setStartupError] = useState(''),
    [page, setPage] = useState('home'),
    [selectedMajor, setSelectedMajor] = useState(''),
    [selectedChat, setSelectedChat] = useState(''),
    [focusEvent, setFocusEvent] = useState(''),
    [settingsTab, setSettingsTab] = useState('api'),
    [onboarding, setOnboarding] = useState(false),
    [apiSetup, setApiSetup] = useState(false),
    [mobile, setMobile] = useState(false),
    [error, setError] = useState(''),
    [progress, setProgress] = useState<RecoveryProgress>(),
    [selectedCharacter, setSelectedCharacter] = useState<Character>(),
    [routePulse, setRoutePulse] = useState(0),
    [worldShift, setWorldShift] = useState<{
      key: number;
      name: string;
      color: string;
      era: string;
    }>(),
    [recoveryMinimized, setRecoveryMinimized] = useState(false),
    [reducedMotion, setReducedMotion] = useState(false);
  const [cancelController] = useState(() => ({ current: new AbortController() }));
  const routeTimer = useRef<number>(),
    worldTimer = useRef<number>(),
    recoveryToken = useRef(0);
  const data = useLiveQuery(async () => {
    const settings = await db.settings.get('app');
    const convs = settings
      ? await db.conversations.where('worldId').equals(settings.worldId).toArray()
      : [];
    let unread = 0;
    for (const c of convs) {
      const cursor = await db.cursors.get(`observer:${c.id}`);
      unread += await db.messages
        .where('[conversationId+seq]')
        .between([c.id, cursor?.seq ?? 0], [c.id, Number.MAX_SAFE_INTEGER], false, true)
        .count();
    }
    return {
      settings,
      worlds: await db.worlds.filter((w) => !w.deletedAt).toArray(),
      cp: settings ? await db.checkpoints.get(settings.worldId) : undefined,
      profile: await db.profiles.get('api'),
      unread,
    };
  }, []);
  const worldId = data?.settings?.worldId ?? 'w-harbor';
  const activeWorld = data?.worlds.find((w) => w.id === worldId);
  const simHour = activeWorld && data?.cp ? worldTime(activeWorld, data.cp.simTime).hour : 12;
  const timePhase =
    simHour < 5 || simHour >= 21
      ? 'night'
      : simHour < 8
        ? 'dawn'
        : simHour < 17
          ? 'day'
          : simHour < 19
            ? 'dusk'
            : 'evening';
  const uiMode: UIMode = data?.settings?.uiMode ?? 'game';
  const rawMotion: MotionLevel = data?.settings?.motionLevel ?? 'standard';
  const lowPower =
    typeof navigator !== 'undefined' &&
    (((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4 ||
      (navigator.hardwareConcurrency ?? 8) <= 4 ||
      (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData ===
        true);
  const motion: MotionLevel = reducedMotion
    ? rawMotion === 'off'
      ? 'off'
      : 'low'
    : rawMotion === 'standard' && lowPower
      ? 'low'
      : rawMotion;
  const shellStyle = {
    '--world-color': activeWorld?.color || '#d9ef69',
    '--world-cover': activeWorld?.cover
      ? `url("${activeWorld.cover.replaceAll('"', '%22')}")`
      : 'none',
  } as CSSProperties;
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReducedMotion(media.matches);
    sync();
    media.addEventListener?.('change', sync);
    return () => media.removeEventListener?.('change', sync);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.uiMode = uiMode;
    document.documentElement.dataset.motion = motion;
    return () => {
      delete document.documentElement.dataset.uiMode;
      delete document.documentElement.dataset.motion;
    };
  }, [uiMode, motion]);
  useEffect(() => {
    // A new recovery session starts expanded; minimizing it never stops the task.
    if (!progress) {
      setRecoveryMinimized(false);
      recoveryToken.current = 0;
      return;
    }
    if (recoveryToken.current === 0) recoveryToken.current = 1;
  }, [progress]);
  useEffect(
    () => () => {
      window.clearTimeout(routeTimer.current);
      window.clearTimeout(worldTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (data?.profile?.status === 'invalid') setApiSetup(true);
  }, [data?.profile?.status]);
  useEffect(() => {
    seed()
      .then(async () => {
        const { ensureTouhouPresets } = await import('./data/presets/touhou');
        await ensureTouhouPresets();
        setReady(true);
        const s = await db.settings.get('app');
        if (!s?.onboarded) setOnboarding(true);
      })
      .catch((e) => setStartupError(String(e)));
    return () => cancelController.current.abort();
  }, []);
  useEffect(() => {
    if (!ready) return;
    let running = false;
    let foregroundSince: number | undefined =
      document.hidden || !navigator.onLine ? undefined : Date.now();
    let retryAfter = 0;
    const work = async () => {
      if (running || Date.now() < retryAfter) return;
      running = true;
      const startedAt = Date.now();
      const activeSince = document.hidden || !navigator.onLine ? undefined : foregroundSince;
      try {
        const worlds = await db.worlds.filter((w) => !w.deletedAt).toArray();
        for (const world of worlds) {
          const cp = await db.checkpoints.get(world.id);
          if (!cp || cp.paused) continue;
          void drainContent(world.id).catch((e) =>
            diagnostic(world.id, { phase: 'error', error: String(e) }),
          );
          cancelController.current = new AbortController();
          void maintainWorld(world.id).catch((e) =>
            diagnostic(world.id, { phase: 'error', error: String(e) }),
          );
          await runWorld(world.id, {
            signal: cancelController.current.signal,
            now: startedAt,
            foregroundSince: foregroundStart(),
            deferContent: true,
            maxSegments: 24,
            onProgress: (p) => {
              if (p.offline && p.to - p.from > 900000) setProgress(p);
            },
          });
        }
      } catch (e) {
        retryAfter = Date.now() + 30000;
        if (!(e instanceof Error && e.message.includes('取消')))
          setError(e instanceof Error ? e.message : '模拟暂时中断，可以稍后继续。');
      } finally {
        foregroundSince = document.hidden || !navigator.onLine ? undefined : startedAt;
        running = false;
        setProgress(undefined);
      }
    };
    void work();
    const timer = setInterval(work, 1000);
    const visible = () => {
      const at = Date.now(),
        previous = foregroundStart();
      void settleClocks(at, previous).catch((e) => setError(String(e)));
      changeForeground(document.hidden || !navigator.onLine ? undefined : at);
      foregroundSince = document.hidden || !navigator.onLine ? undefined : Date.now();
      if (!document.hidden) void work();
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', visible);
    window.addEventListener('offline', visible);
    return () => {
      clearInterval(timer);
      cancelController.current.abort();
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', visible);
      window.removeEventListener('offline', visible);
    };
  }, [ready, data?.cp?.paused, worldId, data?.settings?.unlimitedUsage]);
  const navigate = (id: string) => {
    setPage(id);
    setMobile(false);
    setRoutePulse((n) => n + 1);
    window.clearTimeout(routeTimer.current);
    routeTimer.current = window.setTimeout(() => setRoutePulse(0), 620);
  };
  const switchWorld = (id: string) => {
    if (!id || id === worldId) return;
    const next = data?.worlds.find((w) => w.id === id);
    setSelectedChat('');
    setWorldShift({
      key: Date.now(),
      name: next?.name ?? '新的世界',
      color: next?.color ?? '#d9ef69',
      era: next?.era ?? 'AD',
    });
    window.clearTimeout(worldTimer.current);
    worldTimer.current = window.setTimeout(() => setWorldShift(undefined), 1150);
    void db.settings.update('app', { worldId: id });
  };
  const openChat = (id: string) => {
    setSelectedChat(id);
    navigate('chats');
  };
  async function toggleRun(running?: boolean) {
    try {
      const cp = await db.checkpoints.get(worldId);
      if (!cp) return;
      const shouldRun = running ?? cp.paused;
      if (!shouldRun) {
        cancelController.current.abort();
        await setRunning(worldId, false, cp.mode);
        return;
      }
      const profile = await db.profiles.get('api');
      const live = profile && getKey(profile);
      if (!live && cp.mode === 'live') {
        setApiSetup(true);
        return;
      }
      await setRunning(worldId, true, live ? 'live' : 'demo');
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }
  const unread = data?.unread ?? 0;
  const recoveryWorld = progress ? data?.worlds.find((w) => w.id === progress.worldId) : undefined;
  const recoveryPct = progress
    ? Math.max(
        0,
        Math.min(
          100,
          Math.round(
            ((progress.at - progress.from) / Math.max(1, progress.to - progress.from)) * 100,
          ),
        ),
      )
    : 0;
  if (startupError)
    return (
      <div className="fatal-error">
        <h1>无法打开本地数据库</h1>
        <p>{startupError}</p>
        <p>请检查浏览器是否允许此站点存储数据。</p>
      </div>
    );
  if (!ready)
    return (
      <div className="startup">
        <Waves size={48} />
        <h1>浮游 AQUARIUM</h1>
        <p>正在打开你的世界…</p>
      </div>
    );
  return (
    <ErrorBoundary>
      <UIPreferencesProvider value={{ mode: uiMode, motion }}>
        <div
          className={`app-shell ${uiMode === 'game' ? 'game-ui' : 'classic-ui'} ${page === 'chats' ? 'chat-page' : ''} ${motion === 'off' ? 'motion-off' : ''}`}
          data-ui={uiMode}
          data-motion={motion}
          data-page={page}
          data-time-phase={timePhase}
          data-paused={data?.cp?.paused ? 'true' : 'false'}
          style={shellStyle}
        >
          <div className="game-backdrop" aria-hidden="true">
            <span className="backdrop-cover" />
            <span className="backdrop-grid" />
            <span className="backdrop-orb orb-a" />
            <span className="backdrop-orb orb-b" />
            <span className="backdrop-stroke stroke-a" />
            <span className="backdrop-stroke stroke-b" />
            <span className="backdrop-noise" />
          </div>
          <aside className={`sidebar ${mobile ? 'mobile-open' : ''}`}>
            <a
              className="brand"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                navigate('home');
              }}
            >
              <span className="brand-symbol">
                <Waves size={29} />
              </span>
              <span>
                <b>
                  浮游<span> AQUARIUM</span>
                </b>
                <small>角色社交观察池</small>
              </span>
            </a>
            <div className="rail-seal game-only" aria-hidden="true">
              <span>OBSERVATION POOL / 01</span>
              <strong>LIVE WORLD ARCHIVE</strong>
              <i />
            </div>
            <button
              className="sidebar-close icon-button"
              aria-label="关闭导航"
              onClick={() => setMobile(false)}
            >
              <X size={23} />
            </button>
            <div className="sidebar-world">
              <span>当前观察世界</span>
              <div>
                <span className="world-mini-icon">◈</span>
                <Select
                  aria-label="切换世界"
                  value={worldId}
                  onChange={(e) => switchWorld(e.target.value)}
                >
                  {data?.worlds.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <span className="nav-label">YOUR OBSERVATORY</span>
            <nav>
              {navigation.map((n, i) => (
                <div key={n.id}>
                  {[0, 6, 8].includes(i) && (
                    <span className="nav-category">
                      {i === 0 ? '世界观察' : i === 6 ? '世界管理' : '全局管理'}
                    </span>
                  )}
                  <button
                    key={n.id}
                    aria-label={n.label}
                    className={page === n.id ? 'active' : ''}
                    onClick={() => navigate(n.id)}
                  >
                    <n.icon size={20} />
                    <span>
                      {n.label}
                      <small>{n.sub}</small>
                    </span>
                    {n.id === 'chats' && unread > 0 ? (
                      <b className="nav-unread">{unread > 99 ? '99+' : unread}</b>
                    ) : page === n.id ? (
                      <span className="nav-mark">↗</span>
                    ) : null}
                  </button>
                </div>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <div className="world-control">
                <div>
                  <span className={`status-dot ${data?.cp?.paused ? 'paused' : ''}`} />
                  <strong>{data?.cp?.paused ? '世界已暂停' : '世界运行中'}</strong>
                  <button
                    className="speed"
                    title="打开时间控制"
                    onClick={() => {
                      setSettingsTab('simulation');
                      navigate('settings');
                    }}
                  >
                    {data?.cp?.timeMode === 'real' ? '真实 1×' : `${data?.cp?.speed ?? 30}×`}
                  </button>
                </div>
                <div className="world-control-meta">
                  <span>
                    {data?.cp?.mode === 'demo'
                      ? '演示模式 · 消息有演示标记'
                      : '真实生成 · 本地优先'}
                  </span>
                </div>
                {uiMode === 'classic' && (
                  <MajorBanner worldId={worldId} onOpen={setSelectedMajor} />
                )}
                <Button variant="primary" onClick={() => void toggleRun()}>
                  {data?.cp?.paused ? <Play size={15} /> : <Pause size={15} />}{' '}
                  {data?.cp?.paused ? '开始观察' : '暂停观察'}
                </Button>
              </div>
              <button
                className={`settings-nav ${page === 'settings' ? 'active' : ''}`}
                onClick={() => navigate('settings')}
              >
                <SettingsIcon size={19} />
                世界设置<span>↗</span>
              </button>
              <div className="sidebar-user">
                <Avatar
                  character={{
                    name: data?.settings?.nickname,
                    avatar: data?.settings?.userAvatar,
                    color: '#e7e9df',
                  }}
                  size={35}
                />
                <div>
                  <strong>{data?.settings?.nickname}</strong>
                  <small>在此，慢慢观察世界</small>
                </div>
                <span>✳</span>
              </div>
            </div>
          </aside>
          {mobile && <div className="sidebar-scrim" onClick={() => setMobile(false)} />}
          <div className="workspace">
            <header className="topbar">
              <button
                className="icon-button mobile-menu"
                aria-label="打开导航"
                onClick={() => setMobile(true)}
              >
                <Menu size={23} />
              </button>
              <div className="breadcrumb">
                <span className="breadcrumb-code">
                  {navigation.find((n) => n.id === page)?.sub ?? 'CONTROL'}
                </span>
                我的观察池 <span>/</span>
                <strong>{navigation.find((n) => n.id === page)?.label ?? '世界设置'}</strong>
              </div>
              <div className="topbar-signal game-only">
                <Radio size={13} />
                <span>{data?.cp?.paused ? 'STANDBY' : 'LIVE SIGNAL'}</span>
                <b>{activeWorld?.name ?? '海盐市'}</b>
                <i />
              </div>
              <div className="topbar-right">
                <span className="local-badge">
                  <i /> LOCAL ONLY
                </span>
                <span className="version">VOL. 001</span>
                <button
                  className="icon-button topbar-settings"
                  aria-label="打开 AI 设置"
                  onClick={() => navigate('settings')}
                >
                  <SettingsIcon size={18} />
                </button>
              </div>
            </header>
            <WorldHUD worldId={worldId} onToggle={(running) => toggleRun(running)} />
            {data?.cp?.mode === 'demo' && (
              <div className="demo-banner">
                <FlaskConical size={15} />
                <span>当前为演示模式。生活按规则运行，演示对白不是真实 AI 生成。</span>
                <button onClick={() => setApiSetup(true)}>
                  连接 AI <ArrowUpRight size={14} />
                </button>
              </div>
            )}
            {error && (
              <div className="global-error">
                <Status error>
                  {error}
                  <button className="text-button" onClick={() => setError('')}>
                    收起
                  </button>
                </Status>
              </div>
            )}
            <main
              key={page}
              className={`main-content page-enter ${page === 'chats' ? 'chat-content' : ''}`}
            >
              {page === 'home' && (
                <Home
                  worldId={worldId}
                  onNavigate={navigate}
                  onChat={openChat}
                  onCharacter={async (id) => setSelectedCharacter(await db.characters.get(id))}
                />
              )}{' '}
              {page === 'worlds' && (
                <Worlds worldId={worldId} onSelect={switchWorld} onConversation={openChat} />
              )}{' '}
              {page === 'characters' && (
                <Characters
                  worldId={worldId}
                  onChat={async (id) => {
                    const c = await db.conversations
                      .where('worldId')
                      .equals(worldId)
                      .and((c) => c.participants.includes(id))
                      .first();
                    if (c) openChat(c.id);
                    else {
                      navigate('chats');
                      setSelectedChat('');
                    }
                  }}
                />
              )}{' '}
              {page === 'chats' && (
                <Chats worldId={worldId} selectedId={selectedChat} onSelect={setSelectedChat} />
              )}{' '}
              {page === 'recycle' && <RecycleBin />}
              {page === 'relationships' && <Relationships worldId={worldId} />}{' '}
              {page === 'majorEvents' && (
                <MajorEvents worldId={worldId} onOpen={setSelectedMajor} />
              )}
              {page === 'scenes' && <Scenes key={worldId} worldId={worldId} />}{' '}
              {page === 'observation' && <ObservationManager worldId={worldId} />}
              {page === 'reports' && (
                <WorldReports
                  worldId={worldId}
                  onCharacter={async (id) => setSelectedCharacter(await db.characters.get(id))}
                  onConversation={openChat}
                  onEvent={async (id) => {
                    const e = await db.events.get(id);
                    if (e) {
                      await db.settings.update('app', { worldId: e.worldId });
                      setFocusEvent(id);
                      navigate('timeline');
                    }
                  }}
                />
              )}
              {page === 'timeline' && (
                <Timeline worldId={worldId} focusEventId={focusEvent} onConversation={openChat} />
              )}{' '}
              {page === 'settings' && <Settings key={settingsTab} initialTab={settingsTab} />}
            </main>
          </div>
          <nav className="mobile-bottom-nav">
            {[
              navigation[0],
              navigation.find((n) => n.id === 'chats')!,
              navigation.find((n) => n.id === 'scenes')!,
              navigation.find((n) => n.id === 'timeline')!,
              { id: 'settings', label: '设置', icon: SettingsIcon },
            ].map((n) => (
              <button
                key={n.id}
                className={page === n.id ? 'active' : ''}
                onClick={() => navigate(n.id)}
              >
                <n.icon size={20} />
                <span>{n.label}</span>
              </button>
            ))}
          </nav>
          {uiMode === 'game' && (
            <div className="game-major-layer">
              <MajorBanner worldId={worldId} onOpen={setSelectedMajor} />
            </div>
          )}
        </div>
        {routePulse > 0 && (
          <div
            key={`route-${page}-${routePulse}`}
            className="route-sweep game-only"
            aria-hidden="true"
          >
            <span className="route-sweep-bar bar-a" />
            <span className="route-sweep-bar bar-b" />
            <span className="route-sweep-label">
              <small>SECTION / {navigation.find((n) => n.id === page)?.sub ?? 'CONTROL'}</small>
              <b>{navigation.find((n) => n.id === page)?.label ?? '世界设置'}</b>
            </span>
          </div>
        )}
        {worldShift && (
          <div
            key={`world-${worldShift.key}`}
            className="world-shift game-only"
            style={{ '--shift-color': worldShift.color } as CSSProperties}
            aria-hidden="true"
          >
            <span className="shift-panel shift-panel-a" />
            <span className="shift-panel shift-panel-b" />
            <span className="shift-panel shift-panel-c" />
            <div className="shift-label">
              <small>NOW ENTERING / WORLD SIGNAL</small>
              <strong>{worldShift.name}</strong>
              <em>{worldShift.era} · OBSERVATION CONTINUES</em>
            </div>
          </div>
        )}
        {selectedMajor && (
          <MajorEventDetail
            eventId={selectedMajor}
            onClose={() => setSelectedMajor('')}
            onConversation={openChat}
          />
        )}
        {onboarding && (
          <Modal
            title="欢迎来到浮游观察池"
            onClose={() =>
              void db.settings.update('app', { onboarded: true }).then(() => setOnboarding(false))
            }
          >
            <div className="welcome-art">
              <Waves size={54} />
              <span>LET LIFE HAPPEN.</span>
            </div>
            <h2>你离开的时候，故事也会继续。</h2>
            <p className="muted">
              先认识海盐市的五位原创角色，或者连接自己的 AI，创建属于你的世界。
            </p>
            <div className="onboarding-steps">
              <span>01 创建世界与角色</span>
              <span>02 配置模型接口</span>
              <span>03 开始观察日常</span>
            </div>
            <p className="muted">
              真实聊天需要你自己的 API
              Key。无密钥时可以浏览、编辑并体验明确标记的演示内容。数据默认保存在此浏览器。
            </p>
            <div className="toolbar">
              <Button
                variant="primary"
                onClick={() => {
                  void db.settings.update('app', { onboarded: true });
                  setOnboarding(false);
                  setApiSetup(true);
                }}
              >
                配置 AI 接口
                <ArrowUpRight size={16} />
              </Button>
              <Button
                onClick={() => {
                  void db.settings.update('app', { onboarded: true });
                  setOnboarding(false);
                }}
              >
                先看看演示世界
              </Button>
            </div>
          </Modal>
        )}
        {apiSetup && (
          <Modal title="AI 连接设置" onClose={() => setApiSetup(false)} wide>
            <ApiSettings onDone={() => setApiSetup(false)} />
          </Modal>
        )}
        {selectedCharacter && (
          <CharacterEditor
            character={selectedCharacter}
            worldId={worldId}
            onClose={() => setSelectedCharacter(undefined)}
          />
        )}{' '}
        {progress && !recoveryMinimized && (
          <div
            className="recovery-screen game-recovery"
            role="dialog"
            aria-modal="true"
            aria-label="离线时间补全"
            style={{ '--recovery-color': recoveryWorld?.color ?? '#d9ef69' } as CSSProperties}
          >
            <div className="recovery-visual" aria-hidden="true">
              <span className="recovery-cover" />
              <span className="recovery-ring ring-a" />
              <span className="recovery-ring ring-b" />
              <span className="recovery-scan" />
              <span className="recovery-glyph">✳</span>
            </div>
            <div className="recovery-copy">
              <span className="eyebrow">WORLD RECOVERY / 离线补全</span>
              <h1>
                正在整理，
                <br />
                你错过的那些日常<span>✳</span>
              </h1>
              <p className="recovery-world">
                {recoveryWorld?.name} · {recoveryWorld?.era ?? 'AD'} · SIGNAL RECONNECTED
              </p>
              <div className="recovery-stage">
                <span className="recovery-stage-dot" />
                <strong>{progress.stage}</strong>
                <small>任务正在后台持续推进</small>
              </div>
              <div
                className="progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={recoveryPct}
              >
                <div style={{ width: `${recoveryPct}%` }} />
                <span className="progress-ticks" aria-hidden="true" />
              </div>
              <div className="recovery-readout">
                <strong>{recoveryPct}%</strong>
                <p>
                  {recoveryWorld && formatWorldTime(recoveryWorld, progress.from)}
                  <span>→</span>
                  {recoveryWorld && formatWorldTime(recoveryWorld, progress.to)}
                </p>
              </div>
              <div className="recovery-counts">
                <span>
                  <b>{progress.events}</b> 个生活事件
                </span>
                <span>
                  <b>{progress.messages}</b> 条消息
                </span>
                <span>
                  <b>{data?.worlds.length ?? 0}</b> 个并行世界
                </span>
              </div>
              <div className="toolbar">
                <Button
                  variant="primary"
                  onClick={() => {
                    cancelController.current.abort();
                    void setRunning(worldId, false, data?.cp?.mode ?? 'demo');
                  }}
                >
                  安全暂停，稍后继续
                </Button>
                <Button onClick={() => setRecoveryMinimized(true)}>收进背景，继续运行</Button>
              </div>
              <small>每个已完成批次都已保存，中断后会从检查点继续；隐藏界面不会取消任务。</small>
            </div>
          </div>
        )}
        {progress && recoveryMinimized && (
          <button
            className="recovery-chip game-only"
            onClick={() => setRecoveryMinimized(false)}
            aria-label="打开离线补全进度"
          >
            <ScanLine size={17} />
            <span>世界补全中 · {recoveryPct}%</span>
            <b>{progress.stage}</b>
          </button>
        )}
      </UIPreferencesProvider>
    </ErrorBoundary>
  );
}
