import { useState, useEffect, useRef, useCallback, Component } from 'react';
import { io } from 'socket.io-client';
import Header from './components/Header.jsx';
import AppNav from './components/AppNav.jsx';
import ControlCard from './components/ControlCard.jsx';
import LogPanel from './components/LogPanel.jsx';
import RunMap from './components/RunMap.jsx';
import EmbeddedBrowserPanel from './components/EmbeddedBrowserPanel.jsx';
import CompletionModal from './components/CompletionModal.jsx';
import LoginBanner from './components/LoginBanner.jsx';
import MessageEditor from './components/MessageEditor.jsx';
import WelcomeModal, { shouldShowWelcome } from './components/WelcomeModal.jsx';
import StatfloIdentityModal from './components/StatfloIdentityModal.jsx';
import AdminPanel from './components/AdminPanel.jsx';
import AuthScreen from './screens/AuthScreen.jsx';
import AccountScreen from './screens/AccountScreen.jsx';
import SupportScreen from './screens/SupportScreen.jsx';
import SubscriptionGate from './screens/SubscriptionGate.jsx';
import EmailVerifiedScreen from './screens/EmailVerifiedScreen.jsx';
import { useAuth } from './hooks/useAuth.js';
import { useSubscription } from './hooks/useSubscription.js';
import { getAccessToken } from './lib/cloudApi.js';
import { Terminal } from 'lucide-react';
import BotIcon from './components/BotIcon.jsx';

const SOCKET_URL = window.location.origin;

console.log('[APP_EXPORT_STRUCTURE_VERIFIED]');

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  render() {
    if (!this.state.hasError) return this.props.children;
    const msg = this.state.error?.message ?? String(this.state.error);
    return (
      <div style={{ minHeight: '100vh', background: '#0a0a0f', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, fontFamily: 'monospace' }}>
        <div style={{ maxWidth: 540, width: '100%', background: '#13131a', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 16, padding: 32 }}>
          <p style={{ color: '#f87171', fontWeight: 700, marginBottom: 12, fontSize: 15 }}>StatfloBot encountered an error</p>
          <pre style={{ color: '#94a3b8', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginBottom: 20, maxHeight: 200, overflow: 'auto' }}>{msg}</pre>
          <button
            onClick={() => window.location.reload()}
            style={{ background: 'linear-gradient(135deg,#4f46e5,#6366f1)', color: '#fff', border: 'none', borderRadius: 10, padding: '10px 20px', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
          >
            Reload app
          </button>
        </div>
      </div>
    );
  }
}

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#0a0a0f' }}>
      <div className="flex flex-col items-center gap-4">
        <BotIcon size={56} />
        <p className="text-sm" style={{ color: '#475569' }}>Loading…</p>
      </div>
    </div>
  );
}

function AppInner() {
  const { user, loading: authLoading, signOut } = useAuth();
  const { account, hasAccess, isAdmin, backendDown, loading: subLoading, refresh: refreshAccount } = useSubscription(user);

  const [activeTab, setActiveTab]       = useState('dashboard');
  const [showSubGate, setShowSubGate]   = useState(false);
  const [showRawLogs, setShowRawLogs]   = useState(false);

  const [runState, setRunState] = useState('idle'); // idle | running | complete
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState({
    processed: 0,
    messaged: 0,
    smsSent: 0,
    dnc: 0,
    skipped: 0,
    failed: 0,
  });
  const [config, setConfig] = useState({
    list: '1st',
    mode: 'live',
    delay: 'safe',
  });
  const [everyoneMode, setEveryoneMode] = useState({ first: false, next: false });
  const [everyoneModeConfirm, setEveryoneModeConfirm] = useState({ show: false, mode: null });
  const [updateReady, setUpdateReady] = useState(false);
  const [updateReadyVersion, setUpdateReadyVersion] = useState(null);
  const [updateOverlay, setUpdateOverlay] = useState(null); // { state, version?, percent? }
  const [identityMismatch, setIdentityMismatch] = useState(null); // { locked, current, reason }
  const [showCompletion, setShowCompletion] = useState(false);
  const [completionStats, setCompletionStats] = useState(null);
  const [connected, setConnected] = useState(false);
  const [loginState, setLoginState] = useState(null);
  const [messageBlockError, setMessageBlockError] = useState(null);
  const [startBlockMessage, setStartBlockMessage] = useState(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const [deviceRegResult, setDeviceRegResult] = useState(null);
  const [lastRunLogFile, setLastRunLogFile] = useState(null);
  const [lastRunStatus,  setLastRunStatus]  = useState(null); // 'complete'|'stopped'|'error'
  const [networkPaused,  setNetworkPaused]  = useState(false);
  const [identityBlockMessage, setIdentityBlockMessage] = useState(null);
  const [lockedStatfloIdentity, setLockedStatfloIdentity] = useState(null);
  const [showStatfloIdentityModal, setShowStatfloIdentityModal] = useState(false);
  const socketRef = useRef(null);
  const updaterStallTimerRef = useRef(null);
  const [socketReconnectBanner, setSocketReconnectBanner] = useState(false);

  // Listen for updater events from Electron — drive the full-screen update overlay
  useEffect(() => {
    if (!window.electron?.onUpdateStatus) return;
    const clearStall = () => {
      if (updaterStallTimerRef.current) {
        clearTimeout(updaterStallTimerRef.current);
        updaterStallTimerRef.current = null;
      }
    };
    const armStall = () => {
      clearStall();
      updaterStallTimerRef.current = setTimeout(() => {
        setUpdateOverlay(prev => prev ? { ...prev, stalled: true } : prev);
      }, 120_000);
    };
    const unsub = window.electron.onUpdateStatus(({ state, version, percent }) => {
      const ver = version ?? null;
      clearStall();
      if (state === 'checking') {
        setUpdateOverlay({ state: 'checking', version: null, percent: 0 });
        armStall();
      } else if (state === 'available') {
        setUpdateOverlay({ state: 'downloading', version: ver, percent: 0 });
        armStall();
      } else if (state === 'downloading') {
        setUpdateOverlay(prev => ({
          ...(prev ?? {}),
          state: 'downloading',
          percent: percent ?? prev?.percent ?? 0,
          version: ver ?? prev?.version ?? null,
          stalled: false,
        }));
        armStall();
      } else if (state === 'restarting') {
        setUpdateOverlay({ state: 'restarting', version: ver, percent: 100 });
      } else if (state === 'installing') {
        setUpdateOverlay(prev => ({ ...(prev ?? {}), state: 'installing', version: ver ?? prev?.version ?? null, percent: 100 }));
      } else if (state === 'uptodate') {
        setUpdateOverlay(null);
      } else if (state === 'no-channel' || state === 'error') {
        setUpdateOverlay(null);
      } else if (state === 'move-required') {
        setUpdateOverlay(null);
      } else if (state === 'ready') {
        setUpdateReady(true);
        setUpdateReadyVersion(ver);
      }
    });
    return () => { unsub(); clearStall(); };
  }, []);

  const isLifetime = isAdmin
    || account?.subscription?.status === 'lifetime'
    || account?.license?.plan === 'lifetime';

  const handleEveryoneModeToggle = useCallback((mode, value) => {
    if (value) {
      setEveryoneModeConfirm({ show: true, mode });
    } else {
      setEveryoneMode(prev => ({ ...prev, [mode]: false }));
    }
  }, []);

  const confirmEveryoneMode = useCallback(() => {
    const { mode } = everyoneModeConfirm;
    setEveryoneMode(prev => ({ ...prev, [mode]: true }));
    setEveryoneModeConfirm({ show: false, mode: null });
  }, [everyoneModeConfirm]);

  // Auto-close subscription gate when hasAccess transitions to true (e.g. after "I just paid" refresh)
  useEffect(() => {
    if ((hasAccess || isAdmin) && showSubGate) {
      setShowSubGate(false);
    }
  }, [hasAccess, isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  // Register this device as soon as the user is authenticated.
  // Fires on login and whenever user identity changes.
  // After success, refreshes account so the device list updates immediately.
  useEffect(() => {
    if (!user || authLoading) return;
    getAccessToken().then(async token => {
      if (!token) return;
      try {
        const res  = await fetch('/api/register-device', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        console.log('[device-reg] on-login result:', data);
        setDeviceRegResult(data);
        // Small delay so the cloud DB write commits before we re-fetch
        await new Promise(r => setTimeout(r, 400));
        await refreshAccount();
      } catch (err) {
        console.warn('[device-reg] on-login failed:', err.message);
      }
    });
  }, [user, authLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show welcome modal on first login or after a successful checkout
  useEffect(() => {
    if (!user) return;
    const isPostCheckout = window.location.search.includes('checkout=success');
    if (isPostCheckout || shouldShowWelcome()) {
      setShowWelcome(true);
    }
  }, [user]);

  // Load locked Statflo identity as soon as user is authenticated.
  useEffect(() => {
    if (!user || authLoading) return;
    getAccessToken().then(async token => {
      if (!token) return;
      try {
        console.log(`[IDENTITY_UI_CHECK_START] userId=${user?.sub ?? user?.id ?? '(none)'}`);
        const res = await fetch('/api/identity', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          console.warn(`[IDENTITY_UI_CHECK_RESULT] failed status=${res.status}`);
          return;
        }
        const data = await res.json();
        console.log(`[IDENTITY_UI_CHECK_RESULT] identityKey=${data.identityKey ?? 'null'} source=${data.source ?? 'unknown'} checkedPath=${data.checkedPath ?? 'none'}`);
        if (data.identityKey) setLockedStatfloIdentity(data.identityKey);
      } catch { /* non-fatal */ }
    });
  }, [user, authLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    let isFirstConnect = true;
    socket.on('connect', () => {
      setConnected(true);
      setSocketReconnectBanner(false);
      if (!isFirstConnect) {
        console.log('[SOCKET_RECONNECTED]');
        fetch('/api/status').then(r => r.json()).then(data => {
          console.log('[SOCKET_STATE_RESYNC] state=' + data.state);
          setRunState(data.state);
          if (data.stats) setStats(data.stats);
        }).catch(() => {});
        fetch('/api/last-identity-block').then(r => r.json()).then(data => {
          if (data && data.reason) {
            setIdentityMismatch({ reason: data.reason, locked: data.locked ?? null, current: data.current ?? null });
            const msg = data.reason === 'mismatch'
              ? 'Account locked to a different Statflo user. Sign into your original Statflo account and try again.'
              : 'Could not verify your Statflo identity. Ensure you are logged into Statflo and try again.';
            setIdentityBlockMessage(msg);
          }
        }).catch(() => {});
      }
      isFirstConnect = false;
    });

    socket.on('disconnect', () => {
      setConnected(false);
      setSocketReconnectBanner(true);
    });

    socket.on('status', ({ state, stats }) => {
      setRunState(state);
      if (stats) setStats(stats);
    });

    socket.on('log', (entry) => {
      setLogs((prev) => [...prev, entry]);
    });

    socket.on('login:required', () => {
      setLoginState('required');
    });

    socket.on('login:detected', () => {
      setLoginState('detecting');
      setTimeout(() => setLoginState(null), 3000);
    });

    socket.on('run:started', () => {
      setRunState('running');
      setLoginState(null);
      setIdentityBlockMessage(null);
      setIdentityMismatch(null);
      setShowCompletion(false);
      setLogs([]);
      setStats({ processed: 0, messaged: 0, smsSent: 0, dnc: 0, skipped: 0, failed: 0 });
    });

    socket.on('run:complete', ({ stats: finalStats, logFile, exitCode }) => {
      const status = (exitCode === 0 || exitCode == null) ? 'complete' : 'error';
      window.electron?.embeddedBrowser?.hide?.();
      setNetworkPaused(false);
      setRunState('complete');
      setLastRunStatus(status);
      if (logFile) setLastRunLogFile(logFile);
      if (finalStats) {
        setStats(finalStats);
        setCompletionStats(finalStats);
      }
      // exitCode 2 = identity block — keep identity modal visible, suppress completion popup
      if (exitCode !== 2) {
        setShowCompletion(true);
      }
    });

    socket.on('run:stopped', ({ logFile, stats: stoppedStats } = {}) => {
      window.electron?.embeddedBrowser?.hide?.();
      setRunState('idle');
      setLoginState(null);
      setLastRunStatus('stopped');
      setNetworkPaused(false);
      if (logFile) setLastRunLogFile(logFile);
      // Preserve stats accumulated before the stop — server includes them now
      if (stoppedStats) setStats(stoppedStats);
    });

    socket.on('run:paused_network', () => setNetworkPaused(true));
    socket.on('run:resumed_network', () => setNetworkPaused(false));

    socket.on('run:identity_blocked', ({ reason, locked, current }) => {
      window.electron?.embeddedBrowser?.notifyRunActive?.(false, 'blocked');
      setIdentityMismatch({ reason, locked: locked ?? null, current: current ?? null });
      // Also set the banner message for inline display on the dashboard tab
      const msg = reason === 'mismatch'
        ? 'Account locked to a different Statflo user. Sign into your original Statflo account and try again.'
        : 'Could not verify your Statflo identity. Ensure you are logged into Statflo and try again.';
      setIdentityBlockMessage(msg);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  // Global renderer error listeners — log for diagnostics without overriding ErrorBoundary
  useEffect(() => {
    const onRejection = (e) => {
      console.error('[RENDERER_UNHANDLED_REJECTION]', e.reason);
    };
    const onError = (e) => {
      console.error('[RENDERER_GLOBAL_ERROR]', e.message, e.filename, e.lineno);
    };
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onError);
    };
  }, []);

  const startRun = useCallback(async () => {
    setStartBlockMessage(null);
    try {
      // Attach a fresh JWT so the server can verify access on every run.
      const token = await getAccessToken();

      const res = await fetch('/api/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ ...config, everyoneMode }),
      });

      if (res.status === 403) {
        const err = await res.json();
        console.warn('[start] blocked by server:', err.reason, err.status);

        if (err.reason === 'backend-down' || err.reason === 'backend-unreachable' || err.reason === 'no-cloud-url') {
          // Cloud unreachable — show inline message rather than gate
          setStartBlockMessage('Cannot verify subscription — run is blocked while the licensing server is unreachable. Please try again in a moment.');
          setTimeout(() => setStartBlockMessage(null), 6000);
        } else {
          // Subscription invalid — refresh account and show paywall gate
          await refreshAccount();
          setShowSubGate(true);
        }
        return;
      }

      if (!res.ok) {
        const err = await res.json();
        console.error('Failed to start:', err);
      }
    } catch (e) {
      console.error('Start error:', e);
    }
  }, [config, everyoneMode, refreshAccount]);

  const handleStartRequest = useCallback(async () => {
    const subStatus = account?.subscription?.status ?? 'none';
    const licStatus = account?.license?.status ?? 'none';
    console.log(`[START_GATE_CHECK] hasAccess=${hasAccess} isAdmin=${isAdmin} subStatus=${subStatus} licStatus=${licStatus}`);

    // Subscription gate — block run if no active plan and user is not admin.
    // isAdmin is server-derived (from /api/proxy/account) — never trust frontend state alone.
    if (!hasAccess && !isAdmin) {
      setShowSubGate(true);
      return;
    }

    // Identity gate — require a locked Statflo username before first run.
    console.log(`[IDENTITY_POPUP_DECISION] lockedStatfloIdentity=${lockedStatfloIdentity ?? 'null'} showModal=${!lockedStatfloIdentity}`);
    if (!lockedStatfloIdentity) {
      setShowStatfloIdentityModal(true);
      return;
    }

    // For 2nd/3rd Attempt runs, validate that a message is saved.
    // MUST include the auth token — server requires it in production.
    if (config.list === '2nd' || config.list === '3rd') {
      try {
        const token = await getAccessToken();
        const res = await fetch('/api/messages', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) {
          // Server rejected the request — can't validate, let bot attempt and fail gracefully
          console.warn('[messages-check] server returned', res.status, '— proceeding without validation');
        } else {
          const data = await res.json();
          console.log('[messages-check] fetched:', JSON.stringify(data));
          const key = config.list === '2nd' ? 'secondAttemptMessage' : 'thirdAttemptMessage';
          if (!data[key] || data[key].trim().length === 0) {
            setMessageBlockError(`${config.list} Attempt message is empty — save a message before starting.`);
            setTimeout(() => setMessageBlockError(null), 4000);
            return;
          }
        }
      } catch {
        // Network error — let run proceed
      }
    }
    setMessageBlockError(null);
    startRun();
  }, [config, hasAccess, backendDown, lockedStatfloIdentity, startRun]);

  const handleIdentitySaved = useCallback((identityKey) => {
    setLockedStatfloIdentity(identityKey);
    setShowStatfloIdentityModal(false);
    startRun();
  }, [startRun]);

  const handleStop = useCallback(async () => {
    // Immediately hide the embedded BrowserView before waiting for bot shutdown.
    console.log('[STOP_REQUESTED_HIDE_BROWSER] hiding embedded view immediately on stop');
    window.electron?.embeddedBrowser?.hide?.();
    try {
      await fetch('/api/stop', { method: 'POST' });
    } catch (e) {
      console.error('Stop error:', e);
    }
  }, []);

  const handleNewRun = useCallback(() => {
    setShowCompletion(false);
    setRunState('idle');
    // Do NOT clear logs here — user needs them for post-run inspection.
    // Logs are cleared automatically when the next run:started fires.
    setStats({ processed: 0, messaged: 0, smsSent: 0, dnc: 0, skipped: 0, failed: 0 });
    setCompletionStats(null);
  }, []);

  const handleClearLogs = useCallback(() => {
    setLogs([]);
    setLastRunStatus(null);
    setLastRunLogFile(null);
  }, []);

  // ── Path-based routing (no React Router needed for single extra route) ───────
  if (window.location.pathname === '/auth/verified') return <EmailVerifiedScreen />;

  // ── Auth gating ─────────────────────────────────────────────────────────────
  if (authLoading) return <LoadingScreen />;
  if (!user)       return <AuthScreen />;

  // ── Support form route (auth required) ──────────────────────────────────────
  if (window.location.pathname === '/support') return <SupportScreen user={user} />;

  // isAdmin is already derived in useSubscription from the account payload
  // isElectron: true when running inside the Electron desktop app
  const isElectron = !!window.electron?.isElectron;

  // ── Authed shell ─────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#0a0a0f' }}>
      <Header
        runState={runState}
        connected={connected}
        loginState={loginState}
        user={user}
        account={account}
      />

      <AppNav
        activeTab={activeTab}
        onTabChange={setActiveTab}
        isAdmin={isAdmin}
      />

      {/* ── Dashboard tab ───────────────────────────────────────────────────── */}
      {activeTab === 'dashboard' && (
        <main className={isElectron
          ? 'flex-1 w-full pl-3 pt-2 pr-0 pb-0 overflow-hidden flex flex-col'
          : 'flex-1 container mx-auto px-4 py-6 max-w-7xl'
        }>
          <LoginBanner loginState={loginState} />

          {socketReconnectBanner && !connected && (
            <div
              className="mb-6 rounded-xl border px-4 py-3 flex items-center gap-2 text-sm"
              style={{ background: 'rgba(251,191,36,0.07)', borderColor: 'rgba(251,191,36,0.3)', color: '#fbbf24' }}
            >
              <span className="font-medium">Connection lost — reconnecting to bot server…</span>
            </div>
          )}

          {networkPaused && (
            <div
              className="mb-6 rounded-xl border px-4 py-3 flex items-center gap-2 text-sm"
              style={{ background: 'rgba(251,191,36,0.07)', borderColor: 'rgba(251,191,36,0.3)', color: '#fbbf24' }}
            >
              <span className="font-medium">Network connection was lost. Reconnect Wi-Fi — the run will resume automatically.</span>
            </div>
          )}

          {messageBlockError && (
            <div
              className="mb-6 rounded-xl border px-4 py-3 flex items-center gap-2 text-sm"
              style={{ background: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.3)', color: '#f87171' }}
            >
              <span className="font-medium">{messageBlockError}</span>
            </div>
          )}

          {startBlockMessage && (
            <div
              className="mb-6 rounded-xl border px-4 py-3 flex items-center gap-2 text-sm"
              style={{ background: 'rgba(251,191,36,0.07)', borderColor: 'rgba(251,191,36,0.3)', color: '#fbbf24' }}
            >
              <span className="font-medium">{startBlockMessage}</span>
            </div>
          )}


          <div className={isElectron
            ? 'flex flex-row gap-0 flex-1 min-h-0 overflow-hidden'
            : 'grid grid-cols-1 lg:grid-cols-3 gap-6 h-full'
          }>
            {/* Left column: controls + message editor */}
            <div className={isElectron
              ? 'w-80 flex-shrink-0 flex flex-col gap-3 pr-3 overflow-y-auto border-r border-[#1e1e2e]'
              : 'lg:col-span-1 flex flex-col gap-6'
            }>
              <ControlCard
                config={config}
                setConfig={setConfig}
                runState={runState}
                onStart={handleStartRequest}
                onStop={handleStop}
                isAdmin={isAdmin}
                isLifetime={isLifetime}
                everyoneMode={everyoneMode}
                onEveryoneModeToggle={handleEveryoneModeToggle}
              />
              <MessageEditor runState={runState} />
            </div>

            {/* Right column: embedded automation browser (desktop) or run map (web) */}
            <div className={isElectron
              ? 'flex-1 min-w-0 flex flex-col overflow-hidden'
              : 'lg:col-span-2 flex flex-col gap-3'
            }>
              {/* Admin-only raw log toggle — hidden in embedded browser mode */}
              {isAdmin && !window.electron?.embeddedBrowser && (
                <div className="flex justify-end">
                  <button
                    onClick={() => setShowRawLogs(v => !v)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                    style={{
                      background: showRawLogs ? 'rgba(99,102,241,0.15)' : '#13131a',
                      border: `1px solid ${showRawLogs ? 'rgba(99,102,241,0.4)' : '#1e1e2e'}`,
                      color: showRawLogs ? '#818cf8' : '#475569',
                    }}
                  >
                    <Terminal size={12} />
                    {showRawLogs ? 'Show Path View' : 'Show Raw Logs'}
                  </button>
                </div>
              )}
              <div className="flex-1 min-h-0 flex flex-col">
                {window.electron?.embeddedBrowser
                  ? <EmbeddedBrowserPanel runState={runState} lastRunStatus={lastRunStatus} />
                  : isAdmin && showRawLogs
                    ? <LogPanel logs={logs} runState={runState} lastRunStatus={lastRunStatus} lastRunLogFile={lastRunLogFile} onClear={handleClearLogs} />
                    : <RunMap logs={logs} runState={runState} />
                }
              </div>
            </div>
          </div>
        </main>
      )}

      {/* ── Account tab ─────────────────────────────────────────────────────── */}
      {activeTab === 'account' && (
        <AccountScreen
          user={user}
          account={account}
          backendDown={backendDown}
          onSignOut={signOut}
          onRefresh={refreshAccount}
          hasAccess={hasAccess}
          isAdmin={isAdmin}
          lockedStatfloIdentity={lockedStatfloIdentity}
          lastRunLogFile={lastRunLogFile}
          lastRunStatus={lastRunStatus}
        />
      )}

      {/* ── Admin tab ───────────────────────────────────────────────────────── */}
      {activeTab === 'admin' && isAdmin && (
        <AdminPanel
          account={account}
          backendDown={backendDown}
          deviceRegResult={deviceRegResult}
          onRefresh={async () => {
            await refreshAccount();
            // Re-register device on every manual refresh so the count updates immediately
            const token = await getAccessToken();
            if (token) {
              fetch('/api/register-device', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
              })
                .then(r => r.json())
                .then(data => { console.log('[device-reg] refresh result:', data); setDeviceRegResult(data); })
                .catch(() => {});
            }
          }}
          onShowWelcome={() => setShowWelcome(true)}
        />
      )}

      {/* ── Modals ──────────────────────────────────────────────────────────── */}
      {showSubGate && (
        <SubscriptionGate
          subscription={account?.subscription}
          onDismiss={() => setShowSubGate(false)}
          onRefresh={refreshAccount}
        />
      )}

      {showCompletion && (
        <CompletionModal
          stats={completionStats || stats}
          onClose={handleNewRun}
        />
      )}

      {showWelcome && (
        <WelcomeModal onClose={() => setShowWelcome(false)} />
      )}

      {showStatfloIdentityModal && (
        <StatfloIdentityModal
          onSaved={handleIdentitySaved}
          onClose={() => setShowStatfloIdentityModal(false)}
        />
      )}

      {/* Identity mismatch modal */}
      {identityMismatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}>
          <div className="rounded-2xl p-6 max-w-md w-full mx-4 border" style={{ background: '#13131f', borderColor: 'rgba(239,68,68,0.3)' }}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(239,68,68,0.12)' }}>
                <span style={{ fontSize: 18 }}>⚠</span>
              </div>
              <h2 className="text-base font-semibold" style={{ color: '#f87171' }}>Wrong Statflo account</h2>
            </div>
            <p className="text-sm mb-4" style={{ color: '#94a3b8', lineHeight: 1.6 }}>
              This paid StatfloBot account can only be used by the original paid Statflo user.
            </p>
            {(identityMismatch.locked || identityMismatch.current) && (
              <div className="rounded-xl px-4 py-3 mb-4 space-y-1.5 text-sm" style={{ background: '#0a0a0f', border: '1px solid #1e1e2e' }}>
                {identityMismatch.locked && (
                  <div className="flex justify-between">
                    <span style={{ color: '#64748b' }}>Expected account</span>
                    <span className="font-mono text-xs" style={{ color: '#e2e8f0' }}>{identityMismatch.locked}</span>
                  </div>
                )}
                {identityMismatch.current && (
                  <div className="flex justify-between">
                    <span style={{ color: '#64748b' }}>Signed in as</span>
                    <span className="font-mono text-xs" style={{ color: '#f87171' }}>{identityMismatch.current}</span>
                  </div>
                )}
              </div>
            )}
            <p className="text-xs mb-4" style={{ color: '#64748b', lineHeight: 1.6 }}>
              Please sign out of Statflo and log back in with the correct account, or contact support if this account needs to be reset.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => { setIdentityMismatch(null); setRunState('idle'); }}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold"
                style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171', border: '1px solid rgba(239,68,68,0.25)' }}
              >
                Close
              </button>
              <button
                onClick={() => { setIdentityMismatch(null); setRunState('idle'); setActiveTab('account'); }}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: '#1e1e2e', color: '#818cf8', border: '1px solid #2e2e3e' }}
              >
                Open Account Logs
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Discord-style update overlay — shown for every updater stage */}
      {updateOverlay && (
        <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center" style={{ background: '#0a0a0f' }}>
          <div className="flex flex-col items-center gap-6 max-w-sm w-full px-8">
            <BotIcon size={64} />
            <div className="text-center">
              <h2 className="text-lg font-bold text-white mb-1">
                {updateOverlay.state === 'checking'   ? 'Checking for updates…'          :
                 updateOverlay.state === 'restarting' ? 'Restarting into latest version…' :
                 updateOverlay.state === 'installing' ? 'Installing update…'              :
                                                        'Updating StatfloBot…'}
              </h2>
              {updateOverlay.version && (
                <p className="text-sm" style={{ color: '#64748b' }}>Version {updateOverlay.version}</p>
              )}
            </div>
            <div className="w-full rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.07)', height: 6 }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${(updateOverlay.state === 'restarting' || updateOverlay.state === 'installing') ? 100 : (updateOverlay.percent ?? 0)}%`,
                  background: 'linear-gradient(90deg, #6366f1, #818cf8)',
                }}
              />
            </div>
            <p className="text-sm" style={{ color: '#475569' }}>
              {updateOverlay.stalled                ? 'Update taking longer than expected…'  :
               updateOverlay.state === 'checking'   ? 'Looking for a new version…'          :
               updateOverlay.state === 'restarting' ? 'The app will restart automatically…' :
               updateOverlay.state === 'installing' ? 'Please wait — do not close the app…' :
                                                      `Downloading… ${updateOverlay.percent ?? 0}%`}
            </p>
          </div>
        </div>
      )}

      {/* Legacy update-ready modal (manual check from Account tab) */}
      {updateReady && !updateOverlay && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}>
          <div className="rounded-2xl p-6 max-w-sm w-full mx-4 flex flex-col gap-4" style={{ background: '#13131a', border: '1px solid #1e1e2e' }}>
            <div>
              <h2 className="text-base font-semibold mb-1" style={{ color: '#f1f5f9' }}>Update available</h2>
              <p className="text-sm" style={{ color: '#94a3b8' }}>
                {updateReadyVersion
                  ? `StatfloBot v${updateReadyVersion} is ready to install.`
                  : 'A new version of StatfloBot is ready to install.'}
                {' '}Restart the app to apply the update.
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => { window.electron?.installUpdate?.(); }}
                className="flex-1 py-2 rounded-lg text-sm font-semibold"
                style={{ background: 'linear-gradient(135deg, #6366f1, #818cf8)', color: 'white' }}
              >
                Install update
              </button>
              <button
                onClick={() => setUpdateReady(false)}
                className="flex-1 py-2 rounded-lg text-sm font-medium"
                style={{ background: '#1e1e2e', color: '#64748b' }}
              >
                Later
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Everyone Mode confirmation modal */}
      {everyoneModeConfirm.show && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}>
          <div className="rounded-2xl p-6 max-w-sm w-full mx-4 flex flex-col gap-4" style={{ background: '#13131a', border: '1px solid rgba(239,68,68,0.3)' }}>
            <div>
              <h2 className="text-base font-semibold mb-1" style={{ color: '#f87171' }}>Enable Everyone Mode?</h2>
              <p className="text-sm" style={{ color: '#94a3b8' }}>
                {everyoneModeConfirm.mode === 'first'
                  ? 'Everyone Mode will send your message to ALL enabled SMS lines for each client — not just the first available one.'
                  : 'Everyone Mode will send your message via the direct composer AND all available SMS lines for each client.'}
                {' '}Only use this when you intend to reach every contact line.
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={confirmEveryoneMode}
                className="flex-1 py-2 rounded-lg text-sm font-semibold"
                style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', color: '#f87171' }}
              >
                I understand — enable Everyone Mode
              </button>
              <button
                onClick={() => setEveryoneModeConfirm({ show: false, mode: null })}
                className="flex-1 py-2 rounded-lg text-sm font-medium"
                style={{ background: '#1e1e2e', color: '#64748b' }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}
