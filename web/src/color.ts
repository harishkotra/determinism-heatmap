/**
 * Perceptually smooth colour ramp for the determinism score.
 *
 * Interpolation happens in Oklab, which is perceptually uniform, so the ramp
 * reads as one continuous gradient rather than the banded, over-saturated
 * sweep of a naive HSL rainbow. Stops run green (1.0, fully deterministic)
 * through amber to red (0.0, the model wanders).
 */

type RGB = [number, number, number];
type Lab = [number, number, number];

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function rgbToOklab([r, g, b]: RGB): Lab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

function oklabToRgb([L, a, b]: Lab): RGB {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    linearToSrgb(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Stops chosen so the ramp stays legible against a dark background and the
 * midpoint reads clearly as "unstable but not hopeless".
 */
const STOPS: Array<{ t: number; hex: string }> = [
  { t: 0.0, hex: '#e01b3c' }, // red    — model wanders
  { t: 0.34, hex: '#f2700f' }, // orange
  { t: 0.62, hex: '#f2b705' }, // amber
  { t: 0.84, hex: '#a8cf3a' }, // yellow-green
  { t: 1.0, hex: '#17c964' }, // green  — byte-identical every time
];

const LAB_STOPS = STOPS.map((s) => ({ t: s.t, lab: rgbToOklab(hexToRgb(s.hex)) }));

/** Map determinism score (0..1) to an sRGB triple in 0..1. */
export function determinismToRgb(score: number): RGB {
  const t = clamp01(score);

  let lo = LAB_STOPS[0]!;
  let hi = LAB_STOPS[LAB_STOPS.length - 1]!;
  for (let i = 0; i < LAB_STOPS.length - 1; i++) {
    const a = LAB_STOPS[i]!;
    const b = LAB_STOPS[i + 1]!;
    if (t >= a.t && t <= b.t) {
      lo = a;
      hi = b;
      break;
    }
  }

  const span = hi.t - lo.t;
  const k = span === 0 ? 0 : (t - lo.t) / span;

  const lab: Lab = [
    lo.lab[0] + (hi.lab[0] - lo.lab[0]) * k,
    lo.lab[1] + (hi.lab[1] - lo.lab[1]) * k,
    lo.lab[2] + (hi.lab[2] - lo.lab[2]) * k,
  ];

  const [r, g, b] = oklabToRgb(lab);
  return [clamp01(r), clamp01(g), clamp01(b)];
}

export function determinismToCss(score: number): string {
  const [r, g, b] = determinismToRgb(score);
  const to255 = (v: number) => Math.round(v * 255);
  return `rgb(${to255(r)}, ${to255(g)}, ${to255(b)})`;
}

/** CSS gradient string for the legend, sampled from the same ramp. */
export function legendGradient(steps = 24): string {
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    parts.push(`${determinismToCss(t)} ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

/** A darker version of a ramp colour, for the instanced cell's side faces. */
export function darken(score: number, factor = 0.45): RGB {
  const [r, g, b] = determinismToRgb(score);
  return [r * factor, g * factor, b * factor];
}