import { motion, AnimatePresence } from 'framer-motion';
import { LogIn, CheckCircle2, Loader2 } from 'lucide-react';

export default function LoginBanner({ loginState }) {
  if (!loginState) return null;

  return (
    <AnimatePresence>
      {loginState === 'required' && (
        <motion.div
          key="login-required"
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ duration: 0.25 }}
          className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 px-5 py-4 flex items-start gap-4 shadow-lg"
        >
          <div className="mt-0.5 shrink-0">
            <LogIn className="h-5 w-5 text-amber-400" />
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-300 leading-snug">
              Login required — complete login in the browser window
            </p>
            <p className="mt-1 text-xs text-amber-200/70 leading-relaxed">
              Automation will resume automatically once login is detected.
            </p>

            <div className="mt-3 flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 text-amber-400/80 animate-spin" />
              <span className="text-xs text-amber-300/70">
                Waiting for Statflo/Okta login detection…
              </span>
            </div>
          </div>
        </motion.div>
      )}

      {loginState === 'detecting' && (
        <motion.div
          key="login-detecting"
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ duration: 0.2 }}
          className="mb-6 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-5 py-4 flex items-center gap-3"
        >
          <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-emerald-300">
              Login detected — resuming automation…
            </p>
            <p className="mt-0.5 text-xs text-emerald-200/60">
              The bot is continuing from where it left off.
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
