import { useEffect, useRef } from 'react';
import { clamp, lerp } from './math';

/**
 * Document scroll progress (0 at the top, 1 at the bottom), smoothed by a single
 * requestAnimationFrame loop and published through a ref.
 *
 * A ref rather than state on purpose: the 3D scene reads this every frame inside
 * `useFrame`, and re-rendering React 60 times a second to move a camera would cost
 * far more than the camera move itself. Nothing in the tree re-renders while
 * scrolling.
 *
 * One loop serves the whole page, so adding sections costs nothing.
 */
export interface ScrollState {
  /** Smoothed progress the scene should render. */
  current: number;
  /** Raw progress, for anything that must not lag the scrollbar. */
  target: number;
  /** Signed smoothed velocity, useful for lean/skew effects. */
  velocity: number;
}

const SMOOTHING = 0.075;

export function useScrollProgress(enabled = true): React.MutableRefObject<ScrollState> {
  const state = useRef<ScrollState>({ current: 0, target: 0, velocity: 0 });

  useEffect(() => {
    const measure = (): number => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      if (scrollable <= 0) return 0;
      return clamp(window.scrollY / scrollable);
    };

    // Reduced motion: track the scrollbar exactly, with no easing and no rAF loop.
    if (!enabled) {
      const onScroll = (): void => {
        const target = measure();
        state.current.target = target;
        state.current.current = target;
        state.current.velocity = 0;
      };
      onScroll();
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);
      return () => {
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onScroll);
      };
    }

    let frame = 0;
    const tick = (): void => {
      const store = state.current;
      store.target = measure();
      const previous = store.current;
      store.current = lerp(store.current, store.target, SMOOTHING);
      store.velocity = store.current - previous;
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [enabled]);

  return state;
}
