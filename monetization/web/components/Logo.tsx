/**
 * StatfloBot logo mark — speech bubble + automation spark.
 *
 * Replace the SVG paths below with final brand assets.
 * Color variables:
 *   --accent      #6366f1 (indigo)
 *   --accent-light #818cf8 (lighter indigo)
 *
 * Usage:
 *   <Logo size={32} />               → icon mark only
 *   <Logo size={28} wordmark />      → icon + "StatfloBot" text
 */

interface LogoProps {
  size?:     number;
  wordmark?: boolean;
  className?: string;
}

export default function Logo({ size = 32, wordmark = false, className = '' }: LogoProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      {/* Icon mark: speech bubble with automation spark */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {/* Background rounded square */}
        <rect width="32" height="32" rx="8" fill="url(#logo-bg)" />

        {/* Speech bubble body */}
        <path
          d="M7 8.5C7 7.12 8.12 6 9.5 6h13C23.88 6 25 7.12 25 8.5v10C25 19.88 23.88 21 22.5 21H17l-4 4v-4H9.5C8.12 21 7 19.88 7 18.5V8.5Z"
          fill="rgba(255,255,255,0.12)"
          stroke="rgba(255,255,255,0.25)"
          strokeWidth="1"
        />

        {/* Automation spark / zap inside bubble */}
        <path
          d="M18 9.5L13.5 15.5H17L14 22L21 14H17.5L18 9.5Z"
          fill="url(#logo-spark)"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        <defs>
          <linearGradient id="logo-bg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#6366f1" />
            <stop offset="100%" stopColor="#4f46e5" />
          </linearGradient>
          <linearGradient id="logo-spark" x1="13.5" y1="9.5" x2="21" y2="22" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="#c4b5fd" />
          </linearGradient>
        </defs>
      </svg>

      {/* Wordmark — only rendered when wordmark=true */}
      {wordmark && (
        <span
          className="font-semibold tracking-tight leading-none"
          style={{ fontSize: size * 0.56, color: '#f1f5f9' }}
        >
          Statflo<span style={{ color: '#818cf8' }}>Bot</span>
        </span>
      )}
    </span>
  );
}
