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
import WhatsNewModal from './components/WhatsNewModal.jsx';
import StatfloIdentityModal from './components/StatfloIdentityModal.jsx';
import AdminPanel from './components/AdminPanel.jsx';
import AuthScreen from './screens/AuthScreen.jsx';
import AccountScreen from './screens/AccountScreen.jsx';
import RunHistoryScreen from './screens/RunHistoryScreen.jsx';
import SupportScreen from './screens/SupportScreen.jsx';
import SubscriptionGate from './screens/SubscriptionGate.jsx';
import EmailVerifiedScreen from './screens/EmailVerifiedScreen.jsx';
import { getReleaseNotes, shouldShowReleaseNotes } from './lib/releaseNotes.js';
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
  const isAdminRef = useRef(isAdmin);
  useEffect(() => { isAdminRef.current = isAdmin; }, [isAdmin]);

  const [activeTab, setActiveTab]       = useState('dashboard');
  const [showSubGate, setShowSubGate]   = useState(false);
  const [showRawLogs, setShowRawLogs]   = useState(false);
  const [serverEnvStatus, setServerEnvStatus] = useState(null); // null = loading, {_error,errorMessage}=failed, object=fetched
  const _serverEnvFailCount = useRef(0);

  const [runState, setRunState] = useState('idle'); // idle | running | complete
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState({
    processed: 0,
    messaged: 0,
    smsSent: 0,
    dnc: 0,
    skipped: 0,
    duplicateSkipped: 0,
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
  const [whatsNewRelease, setWhatsNewRelease] = useState(null);
  const [deviceRegResult, setDeviceRegResult] = useState(null);
  const [lastRunLogFile, setLastRunLogFile] = useState(null);
  const [lastRunStatus,  setLastRunStatus]  = useState(null); // 'complete'|'stopped'|'error'
  const [lastDiagnostics, setLastDiagnostics] = useState(null);
  const [serverVersionData, setServerVersionData] = useState(null);
  const [serverVersionChecked, setServerVersionChecked] = useState(false);
  const [backendRestartState, setBackendRestartState] = useState(null); // null|'restarting'|{error,...}
  const [portStatus, setPortStatus] = useState(null);
  const [showStaleTechDetails, setShowStaleTechDetails] = useState(false);
  const [networkPaused,  setNetworkPaused]  = useState(false);
  const [identityBlockMessage, setIdentityBlockMessage] = useState(null);
  const [lockedStatfloIdentity, setLockedStatfloIdentity] = useState(() => {
    const stored = localStorage.getItem('statfloIdentityKey');
    if (stored) console.log(`[IDENTITY_LOCALSTORAGE_LOAD] key=${stored}`);
    return stored || null;
  });
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

  const openWhatsNew = useCallback(async (force = false) => {
    let version = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;
    if (window.electron?.getVersion) {
      version = await window.electron.getVersion().catch(() => version);
    }
    const release = getReleaseNotes(version);
    if (release && (force || shouldShowReleaseNotes(version))) {
      setWhatsNewRelease(release);
    }
  }, []);

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

  // First-time onboarding comes first. Returning users see customer-facing
  // release notes once per version; maintenance-only releases have no entry.
  useEffect(() => {
    if (!user) return;
    const isPostCheckout = window.location.search.includes('checkout=success');
    if (isPostCheckout || shouldShowWelcome()) {
      setShowWelcome(true);
    } else {
      openWhatsNew();
    }
  }, [user, openWhatsNew]);

  // Load locked Statflo identity as soon as user is authenticated.
  // localStorage provides an instant value; server check runs in background to sync.
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
        if (data.identityKey) {
          setLockedStatfloIdentity(data.identityKey);
          localStorage.setItem('statfloIdentityKey', data.identityKey);
          console.log(`[IDENTITY_LOCALSTORAGE_SYNC] key=${data.identityKey} source=${data.source}`);
        }
        // Do NOT clear localStorage or show modal when server returns null —
        // the localStorage backup is the source of truth until server confirms.
      } catch { /* non-fatal */ }
    });
  }, [user, authLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch server environment identity on mount to detect wrong server instance.
  // After 2 consecutive failures, set an error sentinel so the UI shows
  // "unavailable" instead of being stuck on "Checking server…" forever.
  useEffect(() => {
    const checkServerEnv = () => {
      fetch('/api/debug/server-env')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data) {
            _serverEnvFailCount.current = 0;
            console.log(`[SERVER_ENV_POLL] instanceId=${data.instanceId ?? '?'} isDesktop=${data.isDesktop} source=${data.source ?? '?'}`);
            setServerEnvStatus(data);
          } else {
            _serverEnvFailCount.current++;
            if (_serverEnvFailCount.current >= 2) {
              setServerEnvStatus({ _error: true, errorMessage: 'Server returned invalid response' });
            }
          }
        })
        .catch(err => {
          _serverEnvFailCount.current++;
          if (_serverEnvFailCount.current >= 2) {
            setServerEnvStatus({ _error: true, errorMessage: err?.message || 'Server unreachable' });
          }
        });
    };
    checkServerEnv();
    const _interval = setInterval(checkServerEnv, 15000);
    return () => clearInterval(_interval);
  }, []);

  // One-shot check of /api/version on mount. Used to detect stale server (old code
  // missing diagnostics routes). If the endpoint 404s, the server is old.
  useEffect(() => {
    fetch('/api/version')
      .then(r => r.ok ? r.json() : null)
      .then(d => { setServerVersionData(d); setServerVersionChecked(true); })
      .catch(() => { setServerVersionChecked(true); });
  }, []);

  // When stale condition is detected, fetch port owner info from Electron.
  useEffect(() => {
    const isStale = serverVersionChecked && (!serverVersionData || !serverVersionData.routeListIncludesDiagnosticsCapture);
    if (!isStale || !window.electron?.getPortStatus) return;
    window.electron.getPortStatus().then(s => setPortStatus(s)).catch(() => {});
  }, [serverVersionChecked, serverVersionData]);

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
      setStats({ processed: 0, messaged: 0, smsSent: 0, dnc: 0, skipped: 0, duplicateSkipped: 0, failed: 0 });
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
      // Auto-capture diagnostics bundle on failure.
      // Try the saved bundle first; if missing (bundle write failed), trigger a fresh capture.
      if (status === 'error' && isAdminRef.current) {
        (async () => {
          try {
            const token = await getAccessToken();
            const headers = token ? { Authorization: `Bearer ${token}` } : {};
            let d = await fetch('/api/diagnostics/latest', { headers }).then(r => r.ok ? r.json() : null);
            if (d?.bundle) { setLastDiagnostics(d.bundle); return; }
            // Saved bundle unavailable — force a capture now
            d = await fetch('/api/diagnostics/capture', { method: 'POST', headers }).then(r => r.ok ? r.json() : null);
            if (d?.bundle) setLastDiagnostics(d.bundle);
          } catch { /* non-fatal */ }
        })();
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

  // Refresh subscription state when user switches to the account tab
  useEffect(() => {
    if (activeTab === 'account' && user) refreshAccount();
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Supabase refreshes access tokens in the renderer. Keep the active local
  // run supplied with that fresh credential so histories from long runs still
  // save after the spawn-time token would have expired.
  useEffect(() => {
    if (runState !== 'running') return undefined;
    let cancelled = false;
    const syncToken = async () => {
      const token = await getAccessToken().catch(() => '');
      if (!token || cancelled) return;
      await fetch('/api/run/session-token', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    };
    syncToken();
    const interval = setInterval(syncToken, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [runState]);

  const startRun = useCallback(async () => {
    setStartBlockMessage(null);

    // Hard-block if the server-env is known and not embedded-ready.
    // Re-fetch fresh state right before the run — the polled state may be stale.
    try {
      const _envRes  = await fetch('/api/debug/server-env');
      const _envData = _envRes.ok ? await _envRes.json() : null;
      if (_envData) {
        _serverEnvFailCount.current = 0;
        setServerEnvStatus(_envData);
      }
      if (_envData && !_envData._error && !_envData.isDesktop) {
        console.error(`[UI_BLOCKED_WRONG_SERVER_INSTANCE] instanceId=${_envData.instanceId ?? '?'} source=${_envData.source ?? '?'} isDesktop=false`);
        setStartBlockMessage(
          'Wrong server: embedded mode unavailable. Quit any terminal server on port 3001 and restart StatfloBot.'
        );
        setTimeout(() => setStartBlockMessage(null), 10000);
        return;
      }
    } catch {
      // Network error fetching env — allow run (server gate will catch it)
    }

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
        } else if (err.accessIssue?.repairable) {
          // The customer may well have paid — our record just isn't there.
          // Showing the paywall would tell them to buy something they already
          // own, so show the repair path instead.
          console.warn(`[RUN_BLOCKED_REPAIRABLE] code=${err.accessIssue.code}`);
          setStartBlockMessage(err.accessIssue.message);
          setTimeout(() => setStartBlockMessage(null), 15000);
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
    // Force a fresh access check before every run — server hasAccess is the source of truth.
    // Never trust cached state; a user whose subscription expired mid-session must be blocked.
    const fresh = await refreshAccount();
    // fresh is null when backend is unreachable — fall back to cached values (fail-open for outages)
    const effectiveHasAccess = fresh !== null ? fresh.hasAccess : hasAccess;
    const effectiveIsAdmin   = fresh !== null ? fresh.isAdmin   : isAdmin;
    console.log(`[START_GATE_CHECK] hasAccess=${effectiveHasAccess} isAdmin=${effectiveIsAdmin} backendDown=${fresh === null}`);

    // Subscription gate — block run if no active plan and user is not admin.
    // isAdmin is server-derived (from /api/proxy/account) — never trust frontend state alone.
    if (!effectiveHasAccess && !effectiveIsAdmin) {
      const issue = fresh?.accessIssue ?? null;
      console.log(`[RUN_BLOCKED_INACTIVE_ACCESS] accessIssue=${issue?.code ?? 'none'}`);
      // A repairable denial means the customer may have paid and our record is
      // missing — tell them how to get it fixed rather than asking them to renew.
      setStartBlockMessage(
        issue?.repairable
          ? issue.message
          : 'Your subscription is inactive. Please renew or upgrade to continue.'
      );
      setTimeout(() => setStartBlockMessage(null), issue?.repairable ? 15000 : 8000);
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
  }, [config, hasAccess, isAdmin, backendDown, lockedStatfloIdentity, refreshAccount, startRun]);

  const handleIdentitySaved = useCallback((identityKey) => {
    console.log(`[IDENTITY_MODAL_CLOSE_AFTER_SAVE] identityKey=${identityKey}`);
    setLockedStatfloIdentity(identityKey);
    localStorage.setItem('statfloIdentityKey', identityKey);
    setShowStatfloIdentityModal(false);
    startRun();
  }, [startRun]);

  const handleStop = useCallback(async () => {
    // Immediately hide the embedded BrowserView before waiting for bot shutdown.
    console.log('[STOP_REQUESTED_HIDE_BROWSER] hiding embedded view immediately on stop');
    window.electron?.embeddedBrowser?.hide?.();
    try {
      const token = await getAccessToken();
      await fetch('/api/stop', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch (e) {
      console.error('Stop error:', e);
    }
  }, []);

  const handleNewRun = useCallback(() => {
    setShowCompletion(false);
    setRunState('idle');
    // Do NOT clear logs here — user needs them for post-run inspection.
    // Logs are cleared automatically when the next run:started fires.
    setStats({ processed: 0, messaged: 0, smsSent: 0, dnc: 0, skipped: 0, duplicateSkipped: 0, failed: 0 });
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
  if (window.location.pathname === '/support') return <SupportScreen user={user} account={account} />;

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

          {serverEnvStatus !== null && !serverEnvStatus._error && !serverEnvStatus.isDesktop && (
            <div
              className="mb-4 rounded-xl border px-4 py-3 flex items-center gap-2 text-sm"
              style={{ background: 'rgba(239,68,68,0.10)', borderColor: 'rgba(239,68,68,0.4)', color: '#f87171' }}
            >
              <span className="font-semibold">Wrong server instance:</span>
              <span>Embedded mode unavailable — runs are blocked. Quit any manual dev server on port 3001 and restart StatfloBot.</span>
            </div>
          )}

          {serverVersionChecked && (!serverVersionData || !serverVersionData.routeListIncludesDiagnosticsCapture) && (() => {
            const uiVer = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown';
            const _portOwner = backendRestartState?.portOwner ?? (portStatus?.portOccupied ? portStatus : null);
            const _safeToKill = portStatus?.safeToKill === true;
            const hasError = backendRestartState && backendRestartState !== 'restarting' && backendRestartState.error;
            return (
              <div
                className="mb-4 rounded-xl border px-4 py-3 text-sm flex flex-col gap-2"
                style={{ background: 'rgba(239,68,68,0.10)', borderColor: 'rgba(239,68,68,0.4)', color: '#f87171' }}
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-semibold">App update needs a quick restart</span>
                  {backendRestartState === 'restarting' && (
                    <span className="text-xs" style={{ color: '#fbbf24' }}>Fixing…</span>
                  )}
                </div>
                <span className="text-xs" style={{ color: '#fca5a5' }}>
                  {hasError
                    ? `Restart failed: ${backendRestartState.error}`
                    : "A background service update is pending. Click Fix Now — your run history won't be affected."}
                </span>
                {window.electron?.restartBackend && (
                  <div className="flex gap-2 flex-wrap items-center">
                    <button
                      onClick={async () => {
                        setShowStaleTechDetails(false);
                        setBackendRestartState('restarting');
                        try {
                          const result = (_safeToKill && window.electron.killStaleAndRestart)
                            ? await window.electron.killStaleAndRestart()
                            : await window.electron.restartBackend();
                          if (!result?.ok) {
                            setBackendRestartState({
                              error: result?.message || result?.reason || 'unknown error',
                              portOwner: result?.portOwner ?? null,
                            });
                            if (result?.portOwner) setPortStatus({ portOccupied: true, ...result.portOwner });
                          }
                        } catch (e) {
                          setBackendRestartState({ error: e.message });
                        }
                      }}
                      disabled={backendRestartState === 'restarting'}
                      className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all disabled:opacity-40"
                      style={{ background: 'rgba(239,68,68,0.20)', border: '1px solid rgba(239,68,68,0.4)', color: '#fca5a5', cursor: 'pointer' }}
                    >
                      {backendRestartState === 'restarting' ? 'Fixing…' : 'Fix Now'}
                    </button>
                    {hasError && (
                      <button
                        onClick={() => setShowStaleTechDetails(v => !v)}
                        className="text-xs"
                        style={{ color: '#64748b', cursor: 'pointer', textDecoration: 'underline' }}
                      >
                        {showStaleTechDetails ? 'Hide details' : 'Show technical details'}
                      </button>
                    )}
                  </div>
                )}
                {showStaleTechDetails && hasError && (
                  <div className="text-xs font-mono rounded-lg p-2 flex flex-col gap-1" style={{ background: 'rgba(0,0,0,0.3)', color: '#64748b' }}>
                    <div>UI: v{uiVer}</div>
                    <div>Server: {serverVersionData?.serverVersion ? `v${serverVersionData.serverVersion}` : 'no /api/version'}</div>
                    {_portOwner && (
                      <div>Port 3001: PID {_portOwner.pid} · {_portOwner.command}{portStatus?.ownedByServerManager === false ? ' (external)' : ''}</div>
                    )}
                    <button
                      onClick={() => {
                        const txt = [
                          'StatfloBot Stale Backend Report',
                          `Date: ${new Date().toISOString()}`,
                          `UI version: v${uiVer}`,
                          `Server: ${serverVersionData?.serverVersion ? `v${serverVersionData.serverVersion}` : 'unknown (no /api/version)'}`,
                          _portOwner ? `Port 3001: PID ${_portOwner.pid} · ${_portOwner.command}` : 'Port 3001: unknown',
                          `Restart error: ${backendRestartState?.error ?? 'none'}`,
                        ].join('\n');
                        navigator.clipboard.writeText(txt).catch(() => {});
                      }}
                      className="mt-1 self-start"
                      style={{ color: '#818cf8', cursor: 'pointer', textDecoration: 'underline' }}
                    >
                      Copy report
                    </button>
                  </div>
                )}
              </div>
            );
          })()}

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
                embeddedReady={serverEnvStatus === null || serverEnvStatus?._error ? null : !!serverEnvStatus.isDesktop}
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

      {/* ── History tab ───────────────────────────────────────────────────── */}
      {activeTab === 'history' && (
        <RunHistoryScreen isAdmin={isAdmin} />
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
          serverEnvStatus={serverEnvStatus}
          onRefreshServerEnv={() => {
            fetch('/api/debug/server-env')
              .then(r => r.ok ? r.json() : null)
              .then(d => { if (d) setServerEnvStatus(d); })
              .catch(() => {});
          }}
          serverVersionData={serverVersionData}
          diagnostics={isAdmin ? lastDiagnostics : null}
          onRefreshDiagnostics={async () => {
            if (!isAdmin) return { ok: false, errorMessage: 'Admin diagnostics access required.' };
            try {
              const token = await getAccessToken();
              const headers = token ? { Authorization: `Bearer ${token}` } : {};
              const latest = await fetch('/api/diagnostics/latest', { headers }).then(r => r.ok ? r.json() : null);
              if (latest?.bundle) { setLastDiagnostics(latest.bundle); return { ok: true }; }
              // No saved bundle — force capture
              const captureRes = await fetch('/api/diagnostics/capture', { method: 'POST', headers });
              if (captureRes.status === 404) {
                return {
                  ok: false,
                  staleServer: true,
                  errorMessage: 'Backend server is stale and missing diagnostics routes. Restart StatfloBot to finish the update.',
                };
              }
              const captureText = await captureRes.text();
              let captureData = null;
              try { captureData = JSON.parse(captureText); } catch {}
              if (captureData?.bundle) {
                setLastDiagnostics(captureData.bundle);
                return { ok: true };
              }
              const errDetail = captureData?.error
                ? captureData.error
                : captureText.slice(0, 300) || 'empty response';
              return {
                ok: false,
                errorMessage: `/api/diagnostics/capture ${captureRes.ok ? 'returned no bundle' : `failed: ${captureRes.status}`}: ${errDetail}`,
              };
            } catch (e) {
              return { ok: false, errorMessage: e.message };
            }
          }}
          onShowWhatsNew={() => openWhatsNew(true)}
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
          status={lastRunStatus}
          onClose={handleNewRun}
          onSendReport={() => {
            const supportStatus = lastRunStatus === 'error' ? 'error' : 'completed_with_errors';
            setShowCompletion(false);
            window.location.href = `/support?attachLatestLog=1&failedRunPrompt=1&runStatus=${encodeURIComponent(supportStatus)}`;
          }}
        />
      )}

      {showWelcome && (
        <WelcomeModal onClose={() => {
          setShowWelcome(false);
          setTimeout(() => openWhatsNew(), 250);
        }} />
      )}

      {whatsNewRelease && !showWelcome && (
        <WhatsNewModal release={whatsNewRelease} onClose={() => setWhatsNewRelease(null)} />
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
