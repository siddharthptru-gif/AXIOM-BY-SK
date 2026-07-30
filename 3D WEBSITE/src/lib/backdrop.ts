/**
 * The three switchable background moods.
 *
 * These are rendered procedurally on the GPU rather than loaded as video files. The
 * reference design used three hosted MP4s, which would have meant ~40 MB of transfer,
 * a third-party CDN request on every visit, and a background that breaks the day
 * someone else's bucket changes. A shader gives the same continuous motion at a few
 * kilobytes, with no network request at all — which also keeps the Privacy page's
 * claim of exactly one third-party request (the font stylesheet) true.
 *
 * If you would rather ship real footage, drop your own files in `public/video/` and
 * swap `Backdrop` for a stack of crossfading `<video>` elements — the mode indices and
 * the 1200 ms crossfade contract stay the same.
 */
export const BACKDROP_MODES = [
  { id: 0, label: 'Water Wave' },
  { id: 1, label: 'Gridwave' },
  { id: 2, label: 'Light Tunnel' },
] as const;

export type BackdropMode = (typeof BACKDROP_MODES)[number]['id'];

/** Crossfade duration in seconds, matching the reference design's 1200 ms. */
export const BACKDROP_CROSSFADE_S = 1.2;
