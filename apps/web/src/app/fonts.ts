import localFont from 'next/font/local';

// Latin subset only; other scripts fall back to the system stack. The weight
// ranges are the variable files' axes; CSS uses only the website's weights.
export const display = localFont({
  src: './fonts/space-grotesk-latin-wght-normal.woff2',
  variable: '--font-display-face',
  weight: '300 700',
  display: 'swap',
  adjustFontFallback: 'Arial',
  fallback: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
});

export const body = localFont({
  src: './fonts/manrope-latin-wght-normal.woff2',
  variable: '--font-body-face',
  weight: '200 800',
  display: 'swap',
  adjustFontFallback: 'Arial',
  fallback: [
    '-apple-system',
    'BlinkMacSystemFont',
    'Segoe UI',
    'Roboto',
    'Helvetica',
    'Arial',
    'sans-serif',
  ],
});
