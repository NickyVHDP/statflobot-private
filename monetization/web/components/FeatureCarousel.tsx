'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronRight, MousePointerClick, LogIn, MessageSquare, Gauge, BarChart2, Monitor } from 'lucide-react';

const INTERVAL = 4000;

const features = [
  {
    icon: MousePointerClick,
    title: 'Stop repetitive clicking',
    body: 'Run outreach without manually opening account after account.',
    visual: <ClickDemoVisual />,
  },
  {
    icon: LogIn,
    title: 'Keep your login familiar',
    body: 'Same Statflo / Okta login flow you already use — inside a dedicated app window.',
    visual: <LoginDemoVisual />,
  },
  {
    icon: MessageSquare,
    title: 'Save your messaging',
    body: 'Write your 2nd and 3rd attempt messages once. Reuse them every shift.',
    visual: <MessageDemoVisual />,
  },
  {
    icon: Gauge,
    title: 'Stay in control',
    body: 'Start or stop the run from the same screen. No buried settings.',
    visual: <ControlDemoVisual />,
  },
  {
    icon: BarChart2,
    title: 'Know if the run finished',
    body: 'See whether the last run completed, failed, or was stopped — without digging through terminal logs.',
    visual: <RunSummaryVisual />,
  },
  {
    icon: Monitor,
    title: 'Runs on your machine',
    body: 'Local desktop app. No cloud session. No third-party browser control.',
    visual: <LocalDemoVisual />,
  },
];

function ClickDemoVisual() {
  const steps = ['Account opened', 'Message area found', 'Message sent', 'Next account'];
  const [active, setActive] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setActive(p => (p + 1) % steps.length), 900);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex flex-col gap-2">
      {steps.map((label, i) => (
        <motion.div
          key={label}
          animate={{ opacity: i === active ? 1 : 0.3, x: i === active ? 4 : 0 }}
          transition={{ duration: 0.35 }}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs"
          style={{
            background: i === active ? 'rgba(124,58,237,0.15)' : 'rgba(255,255,255,0.03)',
            border: `1px solid ${i === active ? 'rgba(124,58,237,0.35)' : 'rgba(255,255,255,0.06)'}`,
          }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ background: i === active ? '#a78bfa' : '#334155' }}
          />
          <span style={{ color: i === active ? '#c4b5fd' : '#475569' }}>{label}</span>
          {i < active && (
            <span className="ml-auto" style={{ color: '#4ade80' }}>✓</span>
          )}
        </motion.div>
      ))}
    </div>
  );
}

function LoginDemoVisual() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep(p => (p + 1) % 3), 1400);
    return () => clearInterval(t);
  }, []);
  const steps = [
    { label: 'Statflo', sub: 'statflo.com', color: '#818cf8' },
    { label: 'Okta SSO', sub: 'your-company.okta.com', color: '#a78bfa' },
    { label: 'Signed in', sub: 'Session active', color: '#4ade80' },
  ];
  return (
    <div className="flex flex-col items-center gap-4">
      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.4 }}
          className="w-full rounded-xl px-4 py-5 flex flex-col items-center gap-2 text-center"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold mb-1"
            style={{ background: `${steps[step].color}22`, color: steps[step].color }}
          >
            {step + 1}
          </div>
          <p className="text-sm font-semibold text-white">{steps[step].label}</p>
          <p className="text-xs" style={{ color: '#64748b' }}>{steps[step].sub}</p>
        </motion.div>
      </AnimatePresence>
      <div className="flex gap-1.5">
        {steps.map((_, i) => (
          <div
            key={i}
            className="rounded-full transition-all duration-300"
            style={{ width: i === step ? 16 : 6, height: 6, background: i === step ? '#818cf8' : 'rgba(255,255,255,0.12)' }}
          />
        ))}
      </div>
    </div>
  );
}

function MessageDemoVisual() {
  const msgs = ['Thanks for being a valued customer…', 'Following up on my earlier message…'];
  const [typing, setTyping] = useState(0);
  const [chars, setChars] = useState(0);
  useEffect(() => {
    if (chars < msgs[typing].length) {
      const t = setTimeout(() => setChars(c => c + 1), 38);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => { setTyping(p => (p + 1) % 2); setChars(0); }, 1400);
    return () => clearTimeout(t);
  }, [chars, typing]);
  return (
    <div className="flex flex-col gap-3">
      {msgs.map((msg, i) => (
        <div
          key={i}
          className="rounded-lg px-3 py-2.5 text-xs"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          <p className="text-xs mb-1.5 font-medium" style={{ color: '#64748b' }}>
            {i === 0 ? '2nd Attempt' : '3rd Attempt'}
          </p>
          <p style={{ color: i === typing ? '#e2e8f0' : '#475569' }}>
            {i === typing ? msgs[i].slice(0, chars) : msg}
            {i === typing && <span className="inline-block w-px h-3 ml-0.5 bg-indigo-400 animate-pulse" />}
          </p>
        </div>
      ))}
    </div>
  );
}

function ControlDemoVisual() {
  const [running, setRunning] = useState(false);
  const [count, setCount] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setRunning(true), 600);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setCount(c => c + 1), 800);
    return () => clearInterval(t);
  }, [running]);
  return (
    <div className="flex flex-col gap-3">
      <div
        className="rounded-xl px-4 py-3 flex items-center justify-between"
        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
      >
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: running ? '#4ade80' : '#475569', boxShadow: running ? '0 0 6px #4ade8066' : 'none' }}
          />
          <span className="text-sm font-medium" style={{ color: running ? '#4ade80' : '#64748b' }}>
            {running ? 'Running' : 'Idle'}
          </span>
        </div>
        <button
          onClick={() => setRunning(p => !p)}
          className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
          style={running
            ? { background: 'rgba(239,68,68,0.15)', color: '#f87171', border: '1px solid rgba(239,68,68,0.3)' }
            : { background: 'rgba(124,58,237,0.2)', color: '#a78bfa', border: '1px solid rgba(124,58,237,0.35)' }
          }
        >
          {running ? 'Stop' : 'Start'}
        </button>
      </div>
      <div className="flex gap-2">
        <div className="flex-1 rounded-lg px-3 py-2 text-center" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
          <p className="text-xs" style={{ color: '#64748b' }}>Sent</p>
          <p className="text-lg font-bold text-white">{count}</p>
        </div>
        <div className="flex-1 rounded-lg px-3 py-2 text-center" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
          <p className="text-xs" style={{ color: '#64748b' }}>Attempt</p>
          <p className="text-lg font-bold" style={{ color: '#818cf8' }}>2nd</p>
        </div>
      </div>
    </div>
  );
}

function RunSummaryVisual() {
  const states = [
    { label: 'Completed', color: '#4ade80', bg: 'rgba(74,222,128,0.12)', border: 'rgba(74,222,128,0.25)' },
    { label: 'Stopped', color: '#fbbf24', bg: 'rgba(251,191,36,0.10)', border: 'rgba(251,191,36,0.22)' },
    { label: 'Failed', color: '#f87171', bg: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.22)' },
  ];
  const [stateIdx, setStateIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStateIdx(p => (p + 1) % states.length), 1600);
    return () => clearInterval(t);
  }, []);
  const s = states[stateIdx];
  return (
    <div className="flex flex-col gap-3">
      <div
        className="rounded-xl px-4 py-4"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
      >
        <p className="text-xs mb-3 font-medium" style={{ color: '#475569' }}>Last run</p>
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-white">2nd Attempt</span>
          <AnimatePresence mode="wait">
            <motion.span
              key={s.label}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.3 }}
              className="text-xs px-2.5 py-1 rounded-full font-medium"
              style={{ background: s.bg, color: s.color, border: `1px solid ${s.border}` }}
            >
              {s.label}
            </motion.span>
          </AnimatePresence>
        </div>
        <div className="flex gap-2 mt-3">
          <button
            className="flex-1 text-xs py-1.5 rounded-lg font-medium"
            style={{ background: 'rgba(124,58,237,0.15)', color: '#a78bfa', border: '1px solid rgba(124,58,237,0.25)' }}
          >
            Reload Log
          </button>
          <button
            className="flex-1 text-xs py-1.5 rounded-lg font-medium"
            style={{ background: 'rgba(255,255,255,0.04)', color: '#64748b', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            Send Report
          </button>
        </div>
      </div>
    </div>
  );
}

function LocalDemoVisual() {
  return (
    <div className="flex flex-col gap-3">
      {[
        { label: 'Your machine', detail: 'All processing local', icon: '💻', ok: true },
        { label: 'Statflo session', detail: 'Inside app window only', icon: '🔒', ok: true },
        { label: 'Third-party access', detail: 'None', icon: '🚫', ok: false },
        { label: 'Cloud dependency', detail: 'None', icon: '☁️', ok: false },
      ].map(({ label, detail, icon, ok }) => (
        <div
          key={label}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <span className="text-base">{icon}</span>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-white">{label}</p>
            <p style={{ color: '#64748b' }}>{detail}</p>
          </div>
          <span style={{ color: ok ? '#4ade80' : '#f87171' }}>{ok ? '✓' : '✗'}</span>
        </div>
      ))}
    </div>
  );
}

const slideVariants = {
  enter: (dir: number) => ({ x: dir > 0 ? 40 : -40, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir > 0 ? -40 : 40, opacity: 0 }),
};

export default function FeatureCarousel() {
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState(1);
  const [paused, setPaused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const go = useCallback((next: number, direction: number) => {
    setDir(direction);
    setIndex(next);
  }, []);

  const prev = () => {
    setPaused(true);
    go((index - 1 + features.length) % features.length, -1);
    setTimeout(() => setPaused(false), 2000);
  };

  const next = () => {
    setPaused(true);
    go((index + 1) % features.length, 1);
    setTimeout(() => setPaused(false), 2000);
  };

  const goTo = (i: number) => {
    setPaused(true);
    go(i, i > index ? 1 : -1);
    setTimeout(() => setPaused(false), 2000);
  };

  useEffect(() => {
    if (paused) return;
    timerRef.current = setInterval(() => {
      setDir(1);
      setIndex(p => (p + 1) % features.length);
    }, INTERVAL);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [paused]);

  const feature = features[index];
  const Icon = feature.icon;

  return (
    <div
      className="relative rounded-2xl overflow-hidden"
      style={{ background: 'rgba(13,10,25,0.8)', border: '1px solid rgba(124,58,237,0.2)' }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* ambient glow */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse 60% 50% at 20% 50%, rgba(124,58,237,0.08) 0%, transparent 70%)',
        }}
      />

      <div className="relative grid grid-cols-1 md:grid-cols-2 min-h-[320px]">
        {/* Left panel */}
        <div className="flex flex-col justify-center px-8 py-10 md:pr-6">
          <AnimatePresence mode="wait" custom={dir}>
            <motion.div
              key={`left-${index}`}
              custom={dir}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.55, ease: [0.32, 0.72, 0, 1] }}
              className="flex flex-col gap-5"
            >
              <div
                className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(124,58,237,0.18)', border: '1px solid rgba(124,58,237,0.3)' }}
              >
                <Icon size={20} style={{ color: '#a78bfa' }} />
              </div>
              <div>
                <h3 className="text-xl font-bold text-white mb-2 leading-snug">{feature.title}</h3>
                <p className="text-sm leading-relaxed" style={{ color: '#94a3b8' }}>{feature.body}</p>
              </div>
            </motion.div>
          </AnimatePresence>

          {/* Controls */}
          <div className="flex items-center gap-4 mt-8">
            <button
              onClick={prev}
              className="w-8 h-8 rounded-full flex items-center justify-center transition-all hover:scale-110"
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
              aria-label="Previous feature"
            >
              <ChevronLeft size={15} style={{ color: '#64748b' }} />
            </button>
            <div className="flex gap-1.5">
              {features.map((_, i) => (
                <button
                  key={i}
                  onClick={() => goTo(i)}
                  aria-label={`Go to feature ${i + 1}`}
                  className="rounded-full transition-all duration-300 focus:outline-none"
                  style={{
                    width: i === index ? 20 : 6,
                    height: 6,
                    background: i === index ? '#7c3aed' : 'rgba(255,255,255,0.12)',
                  }}
                />
              ))}
            </div>
            <button
              onClick={next}
              className="w-8 h-8 rounded-full flex items-center justify-center transition-all hover:scale-110"
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
              aria-label="Next feature"
            >
              <ChevronRight size={15} style={{ color: '#64748b' }} />
            </button>
          </div>
        </div>

        {/* Divider */}
        <div
          className="hidden md:block absolute top-8 bottom-8"
          style={{ left: '50%', width: 1, background: 'linear-gradient(to bottom, transparent, rgba(124,58,237,0.25), transparent)' }}
        />

        {/* Right panel — live visual */}
        <div className="flex items-center px-8 py-10 md:pl-10">
          <AnimatePresence mode="wait" custom={dir}>
            <motion.div
              key={`right-${index}`}
              custom={dir}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.55, ease: [0.32, 0.72, 0, 1], delay: 0.04 }}
              className="w-full"
            >
              {feature.visual}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Progress bar */}
      {!paused && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
          <motion.div
            key={`progress-${index}`}
            className="h-full"
            style={{ background: 'linear-gradient(90deg, #7c3aed, #818cf8)' }}
            initial={{ width: '0%' }}
            animate={{ width: '100%' }}
            transition={{ duration: INTERVAL / 1000, ease: 'linear' }}
          />
        </div>
      )}
    </div>
  );
}
