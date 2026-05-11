/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        bg:       '#121218',
        panel:    '#1A1A24',
        panel2:   '#1F1F2B',
        line:     '#2A2A36',
        line2:    '#363645',
        ink:      '#E6E6EC',
        mute:     '#8A8A9A',
        mute2:    '#5C5C6E',
        accent:   '#9CB4D4',
        accentDk: '#7C94B4',
        ok:       '#A8C8A0',
        warn:     '#D4C49C',
        err:      '#D49C9C',
      },
    },
  },
  plugins: [],
}
