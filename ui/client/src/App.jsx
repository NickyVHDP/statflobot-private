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
  // Non-admin users default to live; dry run is admin/dev-only
  const [config, setConfig] = useState({
    list: '1st',
    mode: 'live',
    max: '1',
    delay: 'safe',
  });
  const [showConfirm, setShowConfirm] = useState(false);
  const [showCompletion, setShowCompletion] = useState(false);
  const [completionStats, setCompletionStats] = useState(null);
  const [connected, setConnected] = useState(false);
  const [loginState, setLoginState] = useState(null);
  const [messageBlockError, setMessageBlockError] = useState(null);
  const [startBlockMessage, setStartBlockMessage] = useState(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const socketRef = useRef(null);

  // Enforce live-only mode for non-admin users
  useEffect(() => {
    if (!isAdmin && config.mode === 'dry') {
      setConfig(prev => ({ ...prev, mode: 'live' }));
    }
  }, [isAdmin, config.mode]);

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

    socket.on('run:complete', ({ stats: finalStats }) => {
      setRunState('complete');
      if (finalStats) {
        setStats(finalStats);
        setCompletionStats(finalStats);
      }
      setShowCompletion(true);
    });

    socket.on('run:stopped', () => {
      setRunState('idle');
      setLoginState(null);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const handleStartRequest = useCallback(async () => {
    // Subscription gate — block run if no active plan.
    // When the cloud API is unreachable we allow dry-mode runs but not live.
    if (!hasAccess && !backendDown) {
      setShowSubGate(true);
      return;
    }
    if (!hasAccess && backendDown && config.mode === 'live') {
      setShowSubGate(true);
      return;
    }

    // For 2nd/3rd Attempt runs, validate that a message is saved
    if (config.list === '2nd' || config.list === '3rd') {
      try {
        const res = await fetch('/api/messages');
        const data = await res.json();
        const key = config.list === '2nd' ? 'secondAttemptMessage' : 'thirdAttemptMessage';
        if (!data[key] || data[key].trim().length === 0) {
          setMessageBlockError(`${config.list} Attempt message is empty — save a message before starting.`);
          setTimeout(() => setMessageBlockError(null), 4000);
          return;
        }
      } catch {
        // Let the run proceed if the check itself fails
      }
    }
    setMessageBlockError(null);
    if (config.mode === 'live') {
      setShowConfirm(true);
    } else {
      startRun();
    }
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
        body: JSON.stringify(config),
      });

      if (res.status === 403) {
        const err = await res.json();
        console.warn('[start] blocked by server:', err.reason, err.status);

        if (err.reason === 'backend-down' || err.reason === 'backend-unreachable' || err.reason === 'no-cloud-url') {
          // Cloud unreachable, live mode blocked — show inline message rather than gate
          setStartBlockMessage('Cannot verify subscription — live mode is disabled while the licensing server is unreachable. Switch to dry mode to continue.');
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
  }, [config, refreshAccount]);

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
    setLogs([]);
    setStats({ processed: 0, messaged: 0, dnc: 0, skipped: 0, failed: 0 });
    setCompletionStats(null);
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
                  ? <LogPanel logs={logs} runState={runState} />
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
        />
      )}

      {/* ── Admin tab ───────────────────────────────────────────────────────── */}
      {activeTab === 'admin' && isAdmin && (
        <AdminPanel
          account={account}
          backendDown={backendDown}
          onRefresh={refreshAccount}
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
    </div>
  );
}
