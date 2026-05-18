import Image from 'next/image';

// logo-icon.png natural size: 493×449 (circular robot icon, no wordmark, transparent bg)
const ICON_W = 493;
const ICON_H = 449;

interface LogoProps {
  height?:   number;
  // Legacy props accepted for backward compat — ignored
  size?:     number;
  wordmark?: boolean;
  className?: string;
}

export default function Logo({ height = 40, className = '' }: LogoProps) {
  const iconH = height;
  const iconW = Math.round(iconH * (ICON_W / ICON_H));
  const textSize = Math.round(height * 0.52); // scales with height

  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <Image
        src="/logo-icon.png"
        alt=""
        width={iconW}
        height={iconH}
        priority
        aria-hidden="true"
      />
      <span
        aria-label="StatfloBot"
        style={{ fontSize: textSize, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.02em' }}
      >
        <span style={{ color: '#f8fafc' }}>Statflo</span>
        <span style={{ color: '#818cf8' }}>Bot</span>
      </span>
    </span>
  );
}
