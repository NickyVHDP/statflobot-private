import type { Metadata } from 'next';
import './globals.css';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://statflobot.com';

export const metadata: Metadata = {
  title:       'StatfloBot — Statflo Automation',
  description: 'Automate your Statflo outreach. Smart, fast, reliable.',
  metadataBase: new URL(APP_URL),
  icons: {
    icon: [
      { url: '/favicon.ico',  sizes: '32x32',   type: 'image/x-icon' },
      { url: '/icon.png',     sizes: '512x512',  type: 'image/png'    },
    ],
    apple:     [{ url: '/apple-icon.png', sizes: '180x180', type: 'image/png' }],
    shortcut:  [{ url: '/favicon.ico' }],
  },
  manifest: '/manifest.json',
  openGraph: {
    title:       'StatfloBot — Statflo Automation',
    description: 'Automate your Statflo outreach. Smart, fast, reliable.',
    url:         APP_URL,
    siteName:    'StatfloBot',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'StatfloBot' }],
    type:        'website',
    locale:      'en_US',
  },
  twitter: {
    card:        'summary_large_image',
    title:       'StatfloBot — Statflo Automation',
    description: 'Automate your Statflo outreach. Smart, fast, reliable.',
    images:      ['/og-image.png'],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
