# AXIOM — marketing site

The public site for AXIOM: a 3D scroll landing page, real documentation, and legal
pages. Static output, no backend, no database, no accounts.

Built from [`PROMPT.md`](./PROMPT.md), which is the full specification — read that if
you want to know *why* something is the way it is.

---

## Run it

```bash
cd "3D WEBSITE"
npm install
npm run dev        # http://localhost:5173
```

```bash
npm run build      # typecheck, then emit dist/
npm run preview    # serve dist/ locally to check the real build
```

`npm run build` runs the typecheck first on purpose — a broken build should fail before
Vite spends time bundling three.js.

---

## The installer

The download is a plain `<a download>` pointing at a static file. Nothing dynamic is
involved, which is what lets the whole site be hosted anywhere.

```bash
npm run sync-installer
```

That script:

1. finds the newest `AXIOM-Setup-*-x64.exe` in `../AXIOM EXE/dist`,
2. refuses to publish it if the file disagrees with its own `.sha256` sidecar,
3. deletes any older `.exe` in `public/downloads` so two versions are never served,
4. copies it in and re-hashes the copy to prove the copy is intact,
5. prints the exact values to paste into `src/lib/release.ts`.

Then update `src/lib/release.ts` with what it printed. That file is the single source
of truth — the version, size and checksum shown anywhere on the site all come from it,
and the human-readable size is computed from the byte count so the two cannot drift.

Currently published:

| | |
|---|---|
| File | `AXIOM-Setup-1.0.10-x64.exe` |
| Version | 1.0.10 |
| Size | 111,413,051 bytes (106.3 MB) |
| SHA-256 | `3808838ce7f5ce0446a6b4a7f5014038178336f159e44137327e3fc1b36a6d4c` |

### A note on hosting a 106 MB file

`public/downloads/*.exe` is gitignored, because a 106 MB binary does not belong in
version control. For a real deployment, publish the installer as a **GitHub Release
asset** (or any object store) and point `RELEASE.downloadPath` at that absolute URL
instead. The local copy exists so the site works offline and so `npm run preview`
serves a genuinely working download.

If you do keep it local, note that `vite build` copies the whole 106 MB into `dist/`,
so the build takes noticeably longer than the code alone would suggest.

---

## Structure

```
PROMPT.md                 the specification this was built from
scripts/sync-installer.cjs  copy + verify the installer, print release metadata
public/
  logo.png                favicon and og:image only — never rendered in the page
  downloads/              the installer (gitignored)
src/
  lib/
    release.ts            version / filename / bytes / sha256  ← edit this on release
    useScrollProgress.ts  one rAF loop, lerped, published through a ref
    useReducedMotion.ts   live prefers-reduced-motion subscription
    math.ts               clamp / lerp / smoothstep / mapRange / windowProgress
    webgl.ts              capability probe, so a missing context cannot crash the page
  three/                  UNWIRED — see "The 3D layer, and why it is switched off"
    Scene.tsx             fixed canvas, camera rig, lights, bloom
    Backdrop.tsx          shader alternative to the video background
    AxiomMark.tsx         the extruded 3D A, built procedurally from 2D outlines
    Objects.tsx           starfield, grid, app window, provider ring, terminal, checkpoints
  components/             Navbar, Footer, DownloadCard, Reveal
  sections/Sections.tsx   the six scroll sections
  pages/                  Landing, Docs, Legal (Terms + Privacy), NotFound, PageShell
```

### How the 3D scroll works

One WebGL canvas is `position: fixed` behind the whole document, and ordinary page
scroll drives a camera rig through the scene. The HTML sections scroll on top of it.

This is why it feels continuous rather than like six separate widgets: nothing
re-mounts at a section boundary. It also keeps real document scrolling, so anchors,
keyboard paging and mobile momentum all behave normally.

`useScrollProgress` publishes progress through a **ref**, not state. The scene reads it
every frame inside `useFrame`, so nothing in the React tree re-renders while you
scroll. Each 3D object owns a scroll window and eases inside it via `windowProgress`,
which is what stops objects popping in and out.

### Reduced motion

With `prefers-reduced-motion: reduce`, the camera stops travelling, the mark stops
spinning, the starfield freezes, the rAF loop is not started at all, and every reveal
renders in its final state. The page is fully usable with zero motion.

### No WebGL

`hasWebGL()` is checked before the canvas mounts. If there is no context, a static
gradient renders instead. The canvas is `aria-hidden` and `pointer-events: none`
throughout — it is decoration, and the page makes complete sense without it.

---

## Editing content

| What | Where |
|---|---|
| Version, size, checksum, download URL | `src/lib/release.ts` |
| Headlines and section copy | `src/sections/Sections.tsx` |
| Download card, requirements, verify block | `src/components/DownloadCard.tsx` |
| Documentation | `src/pages/Docs.tsx` |
| Terms and Privacy | `src/pages/Legal.tsx` |
| Colours, gradient, type scale | `src/index.css` and `tailwind.config.js` |
| 3D behaviour and scroll windows | `src/three/` |
| Background video URLs and crossfade | `src/components/VideoBackdrop.tsx` |
| Mood labels and crossfade timing | `src/lib/backdrop.ts` |
| Per-letter hover glow and lift | `.split-char` rules in `src/index.css` |

---

## The background, and the type over it

Three layers, bottom to top:

| z | layer | file |
|---|---|---|
| 0 | crossfading video background | `components/VideoBackdrop.tsx` |
| 1 | tint + vertical scrim, so type holds contrast | `pages/Landing.tsx` |
| 10 | the HTML content | `sections/Sections.tsx` |

Three switchable moods — **Water Wave**, **Gridwave**, **Light Tunnel** — crossfading
over 1200 ms, selected from the control under the hero. They are video files served from
a CloudFront CDN.

Nothing else renders over the footage. No 3D, no canvas, and **no images anywhere on the
page** — the wordmark is set in type, and the illustrative content the 3D layer used to
carry is now stated in words. That is a deliberate constraint, not a shortcut: it means
there is exactly one moving thing on screen, so the type always wins.

### The 3D layer, and why it is switched off

`src/three/` holds a complete WebGL scene: an extruded AXIOM mark built procedurally from
2D outlines, a scroll-driven camera rig, and per-section objects (app window, provider
ring, terminal slab, checkpoint stack), plus `Backdrop.tsx` — a shader alternative to the
video with the same three moods and the same 1200 ms crossfade.

None of it is wired up. Running a bloom-composited 3D scene on top of three simultaneously
decoding videos put two things on the same GPU every frame, and the visible result was the
geometry flickering. Tuning it down does not fix the cause; the page only ever needed one
of the two, and the video is the one that was chosen.

It is all still there and it all still compiles, so it can come back on a static
background:

- **Shader background instead of video** — replace `<VideoBackdrop mode={backdropMode} />`
  in `pages/Landing.tsx` with `<Scene>` rendering `<Backdrop>`, drop the video component,
  and correct the Privacy page, which would go back to one third-party request.
- **3D over a plain dark background** — same, minus `<Backdrop>`.

Either way, restore the `manualChunks` entry noted in `vite.config.ts` so three.js caches
separately from the app code.

### Type over moving footage

Flat black needed no help; video does. Two mechanisms, in `src/index.css`:

- `.text-scrim` — a soft radial pool of near-black behind a block of copy, so body text
  holds its contrast ratio when a bright streak passes underneath.
- `.text-lift` — a tight dark shadow on large display type, so letterforms read as
  sitting above the footage rather than dissolving into it.

The overlay is a tint plus a vertical scrim — darkest at the top and bottom where the nav
and footer sit — rather than the reference's flat 10% black, which is nowhere near enough
for 4.5:1 over moving colour.

### Per-letter hover

`SplitText` splits headings into words, then characters. Hovering a word lifts and
warms the whole word slightly; hovering one character lifts it 7px further and gives it
the accent glow. Entirely CSS `:hover` — no pointer listener, no state, no per-frame
cost, and it keeps working while the page scrolls.

Each word is an `inline-block` so characters cannot break mid-word, and the space
between words is a real text node outside the word so lines still wrap naturally. The
wrapper carries `aria-label` and the spans are `aria-hidden`, so screen readers get one
clean string instead of spelling headings out letter by letter. Under reduced motion the
glow stays and the lift is dropped.

---

## Deploying

`npm run build` produces `dist/`. Upload it anywhere static.

The one thing to configure: this is a **single-page app with client-side routes**
(`/docs`, `/terms`, `/privacy`). The host must rewrite unknown paths to
`/index.html`, or those URLs will 404 on a hard refresh.

- **Netlify** — add `public/_redirects` containing `/*  /index.html  200`
- **Vercel** — add `vercel.json` with a rewrite of `/(.*)` to `/index.html`
- **GitHub Pages** — copy `dist/index.html` to `dist/404.html`
- **Cloudflare Pages** — SPA mode handles it automatically

No environment variables are needed, because there is nothing to configure at runtime.
