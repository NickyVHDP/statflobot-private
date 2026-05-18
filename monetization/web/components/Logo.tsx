import Image from 'next/image';

// logo.png natural dimensions: 493×593 (circular icon + StatfloBot wordmark stacked)
const LOGO_W = 493;
const LOGO_H = 593;

interface LogoProps {
  height?:   number;
  // Legacy props accepted but unused — the image already contains the wordmark
  size?:     number;
  wordmark?: boolean;
  className?: string;
}

export default function Logo({ height = 44, className = '' }: LogoProps) {
  const w = Math.round(height * (LOGO_W / LOGO_H));
  return (
    <Image
      src="/logo.png"
      alt="StatfloBot"
      width={w}
      height={height}
      priority
      className={className}
    />
  );
}
