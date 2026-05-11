import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import Header from './components/Header.jsx';
import AppNav from './components/AppNav.jsx';
import ControlCard from './components/ControlCard.jsx';
import LogPanel from './components/LogPanel.jsx';
import RunMap from './components/RunMap.jsx';
import ConfirmModal from './components/ConfirmModal.jsx';
import CompletionModal from './components/CompletionModal.jsx';
import LoginBanner from './components/LoginBanner.jsx';
import MessageEditor from './components/MessageEditor.jsx';
import WelcomeModal, { shouldShowWelcome } from './components/WelcomeModal.jsx';
import AdminPanel from './components/AdminPanel.jsx';
import AuthScreen from './screens/AuthScreen.jsx';
import AccountScreen from './screens/AccountScreen.jsx';
import SubscriptionGate from './screens/SubscriptionGate.jsx';
import EmailVerifiedScreen from './screens/EmailVerifiedScreen.jsx';
import { useAuth } from './hooks/useAuth.js';
import { useSubscription } from './hooks/useSubscription.js';
import { getAccessToken } from './lib/cloudApi.js';
import { Zap, Terminal } from 'lucide-react';

const SOCKET_URL = window.location.origin;

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#0a0a0f' }}>
      <div className="flex flex-col items-center gap-4">
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center"
          style={{ background: 'linear-gradient(135deg, #6366f1, #818cf8)', boxShadow: '0 0 40px rgba(99,102,241,0.35)' }}
        >
          <Zap size={28} className="text-white" />
        </div>
        <p className="text-sm" style={{ color: '#475569' }}>Loading…</p>
      </div>
    </div>
  );
}

export default function App() {
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
  const [showConfirm, setShowConfirm] = useState(false);
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
  const socketRef = useRef(null);

  // Listen for update-ready events from Electron and show popup
  useEffect(() => {
    if (!window.electron?.onUpdateStatus) return;
    const unsub = window.electron.onUpdateStatus(({ state, version }) => {
      if (state === 'ready') {
        setUpdateReady(true);
        setUpdateReadyVersion(version ?? null);
      }
    });
    return unsub;
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

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
    });

    socket.on('disconnect', () => {
      setConnected(false);
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
      setTimeout(() => setLoginState(null), 2000);
    });

    socket.on('run:started', () => {
      setRunState('running');
      setLoginState(null);
      setLogs([]);
      setStats({ processed: 0, messaged: 0, dnc: 0, skipped: 0, failed: 0 });
    });

    socket.on('run:complete', ({ stats: finalStats, logFile, exitCode }) => {
      const status = (exitCode === 0 || exitCode == null) ? 'complete' : 'error';
      setNetworkPaused(false);
      setRunState('complete');
      setLastRunStatus(status);
      if (logFile) setLastRunLogFile(logFile);
      if (finalStats) {
        setStats(finalStats);
        setCompletionStats(finalStats);
      }
      setShowCompletion(true);
    });

    socket.on('run:stopped', ({ logFile, stats: stoppedStats } = {}) => {
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

    return () => {
      socket.disconnect();
    };
  }, []);

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
    setShowConfirm(true);
  }, [config, hasAccess, backendDown]);

  const startRun = useCallback(async () => {
    setShowConfirm(false);
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

  const handleStop = useCallback(async () => {
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
    setStats({ processed: 0, messaged: 0, dnc: 0, skipped: 0, failed: 0 });
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

  // isAdmin is already derived in useSubscription from the account payload

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
        <main className="flex-1 container mx-auto px-4 py-6 max-w-7xl">
          <LoginBanner loginState={loginState} />

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

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-full">
            {/* Left column: controls + message editor */}
            <div className="lg:col-span-1 flex flex-col gap-6">
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

            {/* Right column: run map (customer) or raw logs (admin toggle) */}
            <div className="lg:col-span-2 flex flex-col gap-3">
              {/* Admin-only raw log toggle */}
              {isAdmin && (
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
              <div className="flex-1">
                {isAdmin && showRawLogs
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

      {showConfirm && (
        <ConfirmModal
          config={config}
          onConfirm={startRun}
          onCancel={() => setShowConfirm(false)}
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

      {/* Update-ready modal */}
      {updateReady && (
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
