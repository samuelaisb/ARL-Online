// Reveal motion for content that replaces a loader (see "Loading & motion" in
// src/app.css). Use `in:reveal` on the branch that replaces a loader: Svelte 5
// transitions are local, so it plays only when that branch flips from loading to
// loaded, not on cached renders, tab switches or in-place row updates.
import { prefersReducedMotion } from 'svelte/motion';

/** JS twin of a CSS cubic-bezier() timing function. */
function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t) => (3 * ax * t + 2 * bx) * t + cx;

  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;

    // Newton's method, then bisection if the slope is too flat to converge.
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < 1e-6) return sampleY(t);
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }

    let low = 0;
    let high = 1;
    t = x;
    for (let i = 0; i < 30; i += 1) {
      const value = sampleX(t);
      if (Math.abs(value - x) < 1e-6) break;
      if (value < x) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return sampleY(t);
  };
}

/** Same curve as --ease-reveal in app.css. */
export const easeReveal = cubicBezier(0.2, 0.7, 0.3, 1);

/**
 * Svelte transition: fade in with a 4px rise over 220ms (`in:reveal`).
 * Params: `delay` (ms, default 0), `duration` (ms, default 220), `y` (px, default 4).
 * With prefers-reduced-motion it is an opacity-only fade (160ms unless `duration`).
 */
export function reveal(node, { delay = 0, duration, y = 4 } = {}) {
  const style = getComputedStyle(node);
  const targetOpacity = Number(style.opacity);
  const baseTransform = style.transform === 'none' ? '' : style.transform;

  if (prefersReducedMotion.current) {
    return {
      delay,
      duration: duration ?? 160,
      easing: easeReveal,
      css: (t) => `opacity: ${t * targetOpacity}`,
    };
  }

  return {
    delay,
    duration: duration ?? 220,
    easing: easeReveal,
    css: (t, u) =>
      `opacity: ${t * targetOpacity}; transform: ${baseTransform} translateY(${u * y}px)`,
  };
}

const IMAGE_FAILSAFE_MS = 8000;

/**
 * Attachment for `<img {@attach revealOnLoad}>`: hides the image (.img-pending) only
 * while it is still loading, then lets it fade in. Images that are already complete
 * (cached, or already failed) are left alone, and load errors or an 8s failsafe
 * always clear the class, so an image is never left invisible.
 */
export function revealOnLoad(img) {
  if (img.complete) return;

  img.classList.add('img-pending');

  const timer = setTimeout(finish, IMAGE_FAILSAFE_MS);
  img.addEventListener('load', finish);
  img.addEventListener('error', finish);

  function cleanup() {
    clearTimeout(timer);
    img.removeEventListener('load', finish);
    img.removeEventListener('error', finish);
  }

  function finish() {
    img.classList.remove('img-pending');
    cleanup();
  }

  return () => {
    cleanup();
    img.classList.remove('img-pending');
  };
}
