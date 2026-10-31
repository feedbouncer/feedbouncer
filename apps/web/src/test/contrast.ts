type Rgb = [number, number, number];

function parse(hex: string): { rgb: Rgb; alpha: number } {
  const n = hex.replace('#', '');
  const rgb = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)) as Rgb;
  return { rgb, alpha: n.length === 8 ? parseInt(n.slice(6, 8), 16) / 255 : 1 };
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/** Alpha-composites an 8-digit `#rrggbbaa` over a 6-digit `under` in sRGB; 6-digit colours pass through. */
export function flatten(color: string, under: string): string {
  const { rgb, alpha } = parse(color);
  if (alpha === 1) return color;
  const base = parse(under).rgb;
  return toHex(rgb.map((c, i) => c * alpha + base[i]! * (1 - alpha)) as Rgb);
}

/** sRGB mix, equivalent to `color-mix(in srgb, a W%, b)`. */
export function mix(a: string, b: string, weightOfA: number): string {
  const x = parse(a).rgb;
  const y = parse(b).rgb;
  return toHex(x.map((c, i) => c * weightOfA + y[i]! * (1 - weightOfA)) as Rgb);
}

function luminance(hex: string): number {
  const [r, g, b] = parse(hex).rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio; translucent colours are flattened against `bg` first. */
export function contrastRatio(fg: string, bg: string): number {
  const a = luminance(flatten(fg, bg));
  const b = luminance(flatten(bg, bg));
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}
