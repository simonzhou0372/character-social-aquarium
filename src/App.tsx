import { RecycleBin } from './pages/RecycleBin';
import { maintainWorld } from './core/world-maintenance';
import { WorldReports } from './pages/WorldReports';
import { ObservationManager } from './components/ObservationManager';
import { MajorEvents, MajorBanner, MajorEventDetail } from './pages/MajorEvents';
import { drainContent } from './ai/content-queue';
import { foregroundStart, changeForeground } from './core/clock-presence';
import { settleClocks } from './core/time';
import { diagnostic } from './core/diagnostics';
import { formatWorldTime } from './core/calendar';
import { WorldHUD } from './components/WorldHUD';
import { Scenes } from './pages/Scenes';
import { Component, useEffect, useState, type ReactNode } from 'react';
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
const navigation = [
  { id: 'home', label: '今日观察', sub: 'OVERVIEW', icon: LayoutDashboard },
  { id: 'worlds', label: '世界与团体', sub: 'WORLDS', icon: Globe2 },
  { id: 'chats', label: '聊天消息', sub: 'MESSAGES', icon: MessageCircle },
  { id: 'scenes', label: '线下观察', sub: 'IN PERSON', icon: ContactRound },
  { id: 'characters', label: '角色图鉴', sub: 'CHARACTERS', icon: ContactRound },
  { id: 'relationships', label: '关系网络', sub: 'CONNECTIONS', icon: Network },
  { id: 'majorEvents', label: '重大事件', sub: 'WORLD EVENTS', icon: Globe2 },
  { id: 'reports', label: '世界报告', sub: 'REPORTS', icon: BookOpen },
  { id: 'recycle', label: '回收站', sub: 'RECYCLE BIN', icon: Globe2 },
  { id: 'timeline', label: '生活时间轴', sub: 'LIFE LOG', icon: Clock3 },
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
    [selectedCharacter, setSelectedCharacter] = useState<Character>();
  const [cancelController] = useState(() => ({ current: new AbortController() }));
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
  useEffect(() => {
    if (data?.profile?.status === 'invalid') setApiSetup(true);
  }, [data?.profile?.status]);
  useEffect(() => {
    seed()
      .then(async () => {
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
      <div className={`app-shell ${page === 'chats' ? 'chat-page' : ''}`}>
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
                onChange={(e) => {
                  setSelectedChat('');
                  void db.settings.update('app', { worldId: e.target.value });
                }}
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
            {navigation.map((n) => (
              <button
                key={n.id}
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
              <p>
                <MajorBanner worldId={worldId} onOpen={setSelectedMajor} />
                {data?.cp?.mode === 'demo' ? '演示模式 · 消息有演示标记' : '真实生成 · 本地优先'}
              </p>
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
              我的观察池 <span>/</span>
              <strong>{navigation.find((n) => n.id === page)?.label ?? '世界设置'}</strong>
            </div>
            <div className="topbar-right">
              <span className="local-badge">
                <i /> LOCAL ONLY
              </span>
              <span className="version">VOL. 001</span>
              <button
                className="icon-button"
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
          <main className={`main-content ${page === 'chats' ? 'chat-content' : ''}`}>
            {page === 'home' && (
              <Home
                worldId={worldId}
                onNavigate={navigate}
                onChat={openChat}
                onCharacter={async (id) => setSelectedCharacter(await db.characters.get(id))}
              />
            )}{' '}
            {page === 'worlds' && (
              <Worlds
                worldId={worldId}
                onSelect={(id) => void db.settings.update('app', { worldId: id })}
                onConversation={openChat}
              />
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
            {page === 'majorEvents' && <MajorEvents worldId={worldId} onOpen={setSelectedMajor} />}
            {page === 'scenes' && <Scenes worldId={worldId} />}{' '}
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
            navigation[2],
            navigation[3],
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
      </div>
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
          <p className="muted">先认识海盐市的五位原创角色，或者连接自己的 AI，创建属于你的世界。</p>
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
      {progress && (
        <div className="recovery-screen" role="dialog" aria-modal="true" aria-label="离线时间补全">
          <span className="eyebrow">RECONNECTING THE LITTLE WORLD</span>
          <h1>
            正在整理，
            <br />
            你错过的那些日常<span>✳</span>
          </h1>
          <p>{progress.stage}</p>
          <div className="progress-track">
            <div
              style={{
                width: `${Math.round(((progress.at - progress.from) / (progress.to - progress.from)) * 100)}%`,
              }}
            />
          </div>
          <strong>
            {Math.round(((progress.at - progress.from) / (progress.to - progress.from)) * 100)}%
          </strong>
          <p>
            {data?.worlds.find((w) => w.id === progress.worldId) &&
              formatWorldTime(
                data.worlds.find((w) => w.id === progress.worldId)!,
                progress.from,
              )}{' '}
            →{' '}
            {data?.worlds.find((w) => w.id === progress.worldId) &&
              formatWorldTime(data.worlds.find((w) => w.id === progress.worldId)!, progress.to)}
          </p>
          <div className="recovery-counts">
            <span>{progress.events} 个生活事件</span>
            <span>{progress.messages} 条消息</span>
          </div>
          <Button
            onClick={() => {
              cancelController.current.abort();
              void setRunning(worldId, false, data?.cp?.mode ?? 'demo');
            }}
          >
            安全暂停，稍后继续
          </Button>
          <small>每个已完成批次都已保存，中断后会从检查点继续。</small>
        </div>
      )}
    </ErrorBoundary>
  );
}
