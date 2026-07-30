/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        void: '#05050A',
        canvas: '#0A0A12',
        panel: '#12121C',
        raised: '#1A1A28',
        hairline: '#23233A',
        violet: {
          DEFAULT: '#8B5CF6',
          deep: '#6D28D9',
        },
        magenta: '#C026D3',
        blue: {
          DEFAULT: '#3B82F6',
        },
        cyan: {
          DEFAULT: '#22D3EE',
        },
        ice: '#A5F3FC',
        fg: {
          max: '#FFFFFF',
          DEFAULT: '#E8E8F0',
          muted: '#A0A0B8',
          faint: '#6B6B85',
        },
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      maxWidth: {
        prose: '72ch',
      },
    },
  },
  plugins: [],
};
