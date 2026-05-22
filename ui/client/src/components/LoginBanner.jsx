import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { LogIn, CheckCircle2 } from 'lucide-react';

export default function LoginBanner({ loginState }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (loginState) {
      setVisible(true);
    } else {
      setVisible(false);
    }
  }, [loginState]);

  return (
    <div style={{ position: 'fixed', top: 12, right: 16, zIndex: 200, pointerEvents: 'none' }}>
      <AnimatePresence>
        {visible && loginState === 'required' && (
          <motion.div
            key="login-required"
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'rgba(12,10,6,0.95)',
              border: '1px solid rgba(251,191,36,0.4)',
              borderRadius: 20,
              padding: '7px 14px',
              backdropFilter: 'blur(8px)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            }}
          >
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#fbbf24', flexShrink: 0 }} />
            <LogIn size={13} style={{ color: '#fbbf24', flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontWeight: 500, color: '#fcd34d', whiteSpace: 'nowrap' }}>
              Login required — finish in embedded browser
            </span>
          </motion.div>
        )}

        {visible && loginState === 'detecting' && (
          <motion.div
            key="login-detecting"
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'rgba(6,12,10,0.95)',
              border: '1px solid rgba(52,211,153,0.4)',
              borderRadius: 20,
              padding: '7px 14px',
              backdropFilter: 'blur(8px)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            }}
          >
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#34d399', flexShrink: 0 }} />
            <CheckCircle2 size={13} style={{ color: '#34d399', flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontWeight: 500, color: '#6ee7b7', whiteSpace: 'nowrap' }}>
              Login detected — continuing run
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
