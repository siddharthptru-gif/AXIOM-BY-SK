import { Fragment } from 'react';

/**
 * Split a heading into hoverable words and characters.
 *
 * Hovering a word lifts and warms the whole word slightly; hovering a single character
 * lifts that one further and gives it the accent glow. The interaction is pure CSS
 * (`.split-char:hover`), so there is no pointer listener, no state, and no per-frame
 * work — moving the cursor across a headline costs nothing.
 *
 * Two details that matter:
 *
 * - Each word is an `inline-block` so its characters can never break mid-word, and the
 *   space between words is a real text node OUTSIDE the word, so lines still wrap
 *   naturally at the spaces.
 * - The wrapper carries `aria-label` and the fragments are `aria-hidden`, so assistive
 *   technology reads one clean string instead of spelling the heading out letter by
 *   letter.
 *
 * Gradient text is handled as a whole word rather than per character: with
 * `background-clip: text`, each character would clip its own copy of the gradient and
 * the ramp would restart on every letter.
 */
export function SplitText({
  text,
  className,
  gradient = false,
}: {
  text: string;
  className?: string;
  gradient?: boolean;
}) {
  const words = text.split(' ').filter((word) => word.length > 0);

  if (gradient) {
    return (
      <span className={className} aria-label={text}>
        {words.map((word, index) => (
          <Fragment key={`${word}-${index}`}>
            <span className="split-word is-grad grad-text" aria-hidden="true">
              {word}
            </span>
            {index < words.length - 1 ? ' ' : null}
          </Fragment>
        ))}
      </span>
    );
  }

  return (
    <span className={className} aria-label={text}>
      {words.map((word, wordIndex) => (
        <Fragment key={`${word}-${wordIndex}`}>
          <span className="split-word" aria-hidden="true">
            {Array.from(word).map((character, charIndex) => (
              <span key={`${character}-${charIndex}`} className="split-char">
                {character}
              </span>
            ))}
          </span>
          {wordIndex < words.length - 1 ? ' ' : null}
        </Fragment>
      ))}
    </span>
  );
}
