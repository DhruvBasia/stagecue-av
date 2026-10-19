/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/renderer/index.html',
    './src/renderer/stage.html',
    './src/renderer/src/**/*.{ts,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        av: {
          bg: '#0d1117',
          panel: '#161b22',
          raised: '#21262d',
          border: '#30363d',
          hover: '#2d333b',
          text: '#e6edf3',
          muted: '#8b949e',
          dim: '#6e7681',
          blue: '#38bdf8',
          amber: '#fbbf24',
          red: '#f87171',
          green: '#4ade80'
        }
      },
      fontFamily: {
        sans: [
          'Inter',
          'Segoe UI',
          'system-ui',
          '-apple-system',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif'
        ],
        mono: ['JetBrains Mono', 'Cascadia Mono', 'Consolas', 'SFMono-Regular', 'Menlo', 'monospace']
      },
      keyframes: {
        'freeze-pulse': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(56, 189, 248, 0.75)', backgroundColor: '#0c4a6e' },
          '50%': { boxShadow: '0 0 0 10px rgba(56, 189, 248, 0)', backgroundColor: '#0369a1' }
        },
        'live-blink': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' }
        }
      },
      animation: {
        'freeze-pulse': 'freeze-pulse 1.2s ease-in-out infinite',
        'live-blink': 'live-blink 1.4s ease-in-out infinite'
      }
    }
  },
  plugins: []
};
