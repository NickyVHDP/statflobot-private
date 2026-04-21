import { motion, AnimatePresence } from 'framer-motion';
import { Zap, Wifi, WifiOff, LogIn, Loader2, Activity } from 'lucide-react';

const RUN_STATUS = {
  idle:     { label: 'Standing by',  color: 'text-slate-400',  dot: 'bg-slate-500' },
  running:  { label: 'Running',      color: 'text-green-400',  dot: 'bg-green-400 pulse-running' },
  complete: { label: 'Run complete', color: 'text-indigo-400', dot: 'bg-indigo-400' },
};

function SessionBadge({ loginState, runState }) {
  if (loginState === 'required') {
    return (
      <motion.div
        key="session-login"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.2 }}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
        style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)', color: '#fbbf24' }}
      >
        <Loader2 size={11} className="animate-spin" />
        Login required
      </motion.div>
    );
  }

  if (loginState === 'detecting') {
    return (
      <motion.div
        key="session-detecting"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.2 }}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
        style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)', color: '#34d399' }}
      >
        <LogIn size={11} />
        Login detected
      </motion.div>
    );
  }

  if (runState === 'running') {
    return (
      <motion.div
        key="session-running"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.2 }}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
        style={{ background: 'rgba(34,197,94,0.10)', border: '1px solid rgba(34,197,94,0.25)', color: '#4ade80' }}
      >
        <Activity size={11} />
        Session active
      </motion.div>
    );
  }

  return null;
}

export default function Header({ runState, connected, loginState, user, account }) {
  const status = RUN_STATUS[runState] || RUN_STATUS.idle;

  return (
    <header
      className="border-b sticky top-0 z-40"
      style={{
        background: 'rgba(10, 10, 15, 0.95)',
        borderColor: '#1e1e2e',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
    >
      <div className="container mx-auto px-4 max-w-7xl">
        <div className="flex items-center justify-between h-16">
          {/* Left: logo + title */}
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: 'linear-gradient(135deg, #6366f1, #818cf8)' }}
            >
              <Zap size={18} className="text-white" />
            </div>
            <div>
              <h1 className="text-base font-semibold leading-tight" style={{ color: '#f1f5f9' }}>
                StatfloBot
              </h1>
              <p className="text-xs leading-tight" style={{ color: '#64748b' }}>
                Automated outreach
              </p>
            </div>
          </div>

          {/* Right: user info + session badge + run status + connection */}
          <div className="flex items-center gap-4">
            {/* User email + plan badge */}
            {user && (
              <>
                <div className="flex items-center gap-2">
                  {account?.license?.plan && (
                    <span
                      className="text-xs font-medium px-2 py-0.5 rounded-full"
                      style={{
                        background: account.license.plan === 'lifetime'
                          ? 'rgba(167,139,250,0.15)'
                          : 'rgba(99,102,241,0.15)',
                        color: account.license.plan === 'lifetime' ? '#a78bfa' : '#818cf8',
                      }}
                    >
                      {account.license.plan === 'lifetime' ? 'Lifetime' : 'Monthly'}
                    </span>
                  )}
                  {account?.profile?.is_admin && (
                    <span
                      className="text-xs font-medium px-2 py-0.5 rounded-full"
                      style={{ background: 'rgba(167,139,250,0.15)', color: '#a78bfa' }}
                    >
                      Admin
                    </span>
                  )}
                  <span className="text-xs hidden sm:block" style={{ color: '#475569' }}>
                    {account?.profile?.email ?? user.email}
                  </span>
                </div>
                <div className="h-6 w-px" style={{ background: '#1e1e2e' }} />
              </>
            )}
            <AnimatePresence mode="wait">
              <SessionBadge loginState={loginState} runState={runState} key={loginState ?? runState} />
            </AnimatePresence>

            <div className="h-6 w-px" style={{ background: '#1e1e2e' }} />

            <div className="flex items-center gap-2">
              <span className={`inline-block w-2 h-2 rounded-full ${status.dot}`} />
              <span className={`text-sm font-medium ${status.color}`}>{status.label}</span>
            </div>

            <div className="h-6 w-px" style={{ background: '#1e1e2e' }} />

            <div className="flex items-center gap-1.5">
              {connected ? (
                <>
                  <Wifi size={14} className="text-green-400" />
                  <span className="text-xs text-green-400">Connected</span>
                </>
              ) : (
                <>
                  <WifiOff size={14} className="text-red-400" />
                  <span className="text-xs text-red-400">Disconnected</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
