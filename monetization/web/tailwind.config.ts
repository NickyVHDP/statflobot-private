import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#0d0d14',
          card:    '#13131f',
          raised:  '#1a1a2e',
          border:  'rgba(255,255,255,0.07)',
        },
        accent: {
          DEFAULT: '#7c3aed',
          light:   '#9d5ff5',
          muted:   'rgba(124,58,237,0.15)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
