import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { useReducedMotion } from '../lib/useReducedMotion';

/**
 * Reveal-on-enter for HTML content over the 3D scene.
 *
 * Deliberately separate from the 3D animation: the scene is driven by a scroll ref at
 * 60fps, while this is a one-shot per element. Mixing the two would mean re-rendering
 * React on every scroll frame.
 *
 * With reduced motion requested this renders the final state immediately — no fade,
 * no offset, no delay.
 */
export function Reveal({
  children,
  delay = 0,
  y = 24,
  className,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();

  if (reduced) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-12% 0px -12% 0px' }}
      transition={{ duration: 0.7, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
