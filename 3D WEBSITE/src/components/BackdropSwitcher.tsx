import { BACKDROP_MODES, type BackdropMode } from '../lib/backdrop';

/**
 * Background mood control.
 *
 * Numbered like the reference design (`01 / WATER WAVE`), the active entry at full
 * opacity and the rest dimmed. It is a real radio group rather than a row of buttons,
 * because "pick one of three" is exactly what a radio group means and it gives keyboard
 * users arrow-key selection for free.
 */
export function BackdropSwitcher({
  mode,
  onChange,
}: {
  mode: BackdropMode;
  onChange: (mode: BackdropMode) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Background mood"
      className="flex flex-col items-center gap-2 sm:flex-row sm:gap-7"
    >
      {BACKDROP_MODES.map((item, index) => {
        const active = item.id === mode;
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={active}
            className={`role-link group flex items-baseline gap-2 ${
              active ? 'opacity-100' : 'opacity-55 hover:opacity-75'
            }`}
            onClick={() => onChange(item.id)}
          >
            <span className="font-mono text-[8px] font-medium uppercase leading-3 tracking-[-0.08px] text-fg-faint">
              0{index + 1} /
            </span>
            <span className="text-[11px] font-medium uppercase leading-4 tracking-[0.06em] text-fg">
              {item.label}
            </span>
            <span
              aria-hidden="true"
              className={`h-[1px] w-6 origin-left transition-transform duration-300 ${
                active ? 'scale-x-100' : 'scale-x-0 group-hover:scale-x-100'
              }`}
              style={{ background: 'linear-gradient(90deg, #8b5cf6, #22d3ee)' }}
            />
          </button>
        );
      })}
    </div>
  );
}
