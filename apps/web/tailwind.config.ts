import type { Config } from 'tailwindcss';

// Layout uses Tailwind logical properties (ms/me/ps/pe/start/end/text-start)
// throughout so the UI mirrors automatically when dir="rtl" (ur, ar).
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef7ff',
          100: '#d9edff',
          500: '#1f7aec',
          600: '#1666cc',
          700: '#124f9e',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
