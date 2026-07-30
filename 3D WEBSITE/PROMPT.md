# Build Prompt — AXIOM Marketing Site (3D scroll landing + docs + legal)

> This is the specification the site in this folder was built from. It is written to be
> handed to any capable coding agent and produce the same result. Everything here is
> implementation-level on purpose: colours, easing curves, scroll ranges, geometry.

---

## 0. What this is

Build a **static marketing website for AXIOM**, a Windows desktop AI coding IDE
("vibe coding" app) in the same product category as Cursor, Windsurf, Replit and
Lovable. The single conversion goal is **downloading the Windows installer**.

**Hard constraints — these are not negotiable:**

- **No backend. No database. No API routes. No server-side anything.** The output must
  be a folder of static files that works when served by any static host or opened from
  a plain file server.
- **No user accounts.** No login, no signup, no auth, no "get started free" gate, no
  email capture, no newsletter, no waitlist. A visitor lands and downloads.
- **Windows x64 only.** Do not render macOS or Linux buttons, tabs, or "coming soon"
  placeholders for other platforms. One platform, one button.
- **No analytics, no tracking pixels, no third-party scripts** beyond the Google Fonts
  stylesheet. The product's own privacy promise is that it phones home to nothing, so
  the site must not undercut it.
- The installer is served as a **static file from `public/downloads/`**, linked with a
  plain `<a download>`. No download service, no redirect, no counter.

**Stack:** React 18 + Vite 5 + TypeScript + Tailwind CSS 3 + React Three Fiber
(three.js) + framer-motion + react-router-dom. Package manager: npm.

---

## 1. Brand

AXIOM's mark is a two-stroke geometric **A** on near-black: the left blade is violet
shading to magenta, the right blade is blue shading to cyan, with a silver `AXIOM`
wordmark and the tagline **"VIBE. BUILD. ANYTHING."** in a violet→cyan gradient.

The whole site derives from that mark. Near-black surfaces, violet→cyan as the only
accent axis, silver-white type. No other hues. No orange, no green, no red except for
a genuine error state.

### Palette (exact)

```
--void:          #05050A   /* page background, deepest */
--canvas:        #0A0A12   /* section background */
--panel:         #12121C   /* cards, surfaces */
--panel-raised:  #1A1A28   /* hover / raised surfaces */
--hairline:      #23233A   /* 1px borders */

--violet:        #8B5CF6   /* primary accent */
--violet-deep:   #6D28D9
--magenta:       #C026D3   /* left-blade gradient end */
--blue:          #3B82F6
--cyan:          #22D3EE   /* right-blade gradient end */
--ice:           #A5F3FC   /* highlight, sparingly */

--fg-max:        #FFFFFF
--fg:            #E8E8F0   /* body text */
--fg-muted:      #A0A0B8   /* secondary text */
--fg-faint:      #6B6B85   /* labels, meta, legal */
```

The signature gradient, used for the wordmark, primary button and section rules:

```
linear-gradient(100deg, #8B5CF6 0%, #6366F1 35%, #3B82F6 65%, #22D3EE 100%)
```

### Typography (Google Fonts, loaded in `index.html`)

- **Space Grotesk** (500, 600, 700) — display headings, the logotype, stat numbers.
- **Inter** (300–700) — body copy, navigation, buttons, legal pages.
- **JetBrains Mono** (400, 500) — code, terminal output, hashes, file names, version
  strings.

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
  rel="stylesheet"
/>
```

---

## 2. Architecture

```
index.html
public/
  downloads/AXIOM-Setup-<version>-x64.exe   ← the real installer, served statically
  logo.png                                  ← the AXIOM mark, for nav + og:image
src/
  main.tsx                react root + router
  App.tsx                 routes
  index.css               tailwind layers + design tokens + utility classes
  lib/
    release.ts            single source of truth for version / size / sha256 / filename
    math.ts               clamp, lerp, smoothstep, mapRange
    useScrollProgress.ts  rAF-smoothed document scroll progress (0→1)
    useReducedMotion.ts   prefers-reduced-motion subscription
    webgl.ts              WebGL capability probe
  three/
    Scene.tsx             one persistent fixed-position Canvas + camera rig + bloom
    AxiomMark.tsx         the extruded 3D A, built procedurally (no model file)
    Objects.tsx           Starfield, GridFloor, AppWindow, ProviderRing,
                          TerminalSlab, CheckpointStack
  components/
    Navbar.tsx  Footer.tsx  DownloadCard.tsx  Reveal.tsx
  sections/
    Sections.tsx          the six scroll sections as HTML overlays
  pages/
    Landing.tsx  Docs.tsx  Legal.tsx (Terms + Privacy)  NotFound.tsx
```

### The one idea that makes it feel 3D

**A single WebGL canvas is `position: fixed` behind the whole document. Normal
document scrolling drives a camera rig through a scene; the HTML sections scroll on
top of it as translucent overlays.**

This beats the usual approach (a separate 3D block per section) for three reasons: the
3D never re-mounts so it never stutters, real document scroll keeps anchors, keyboard
paging and mobile momentum working, and the HTML remains fully readable if WebGL is
unavailable.

```ts
// useScrollProgress.ts — one rAF loop, lerped, published through a ref.
const target = scrollTop / (scrollHeight - innerHeight);   // 0 → 1
current += (target - current) * 0.075;                     // critical damping feel
```

Every 3D object reads that progress inside `useFrame` and maps it through its own
window with `smoothstep` so entrances and exits ease rather than snap:

```ts
const local = smoothstep(mapRange(progress, enter, exit, 0, 1));
```

**Everything animated must use `translate3d` / direct `position`+`rotation` mutation
inside `useFrame`, never React state per frame.** No `setState` in an animation loop.

### Reduced motion is a hard requirement

When `prefers-reduced-motion: reduce` is set: the camera stops travelling, the mark
stops spinning, the starfield stops drifting, framer-motion transitions become
instant, and every section renders in its final resting state. The page must be fully
usable and fully legible with zero motion.

---

## 3. Sections

Six full-height sections. Scroll windows are fractions of total document progress.

### 3.1 Hero — `0.00 → 0.16`

3D: the **AXIOM mark** centred, filling roughly a third of the viewport height,
rotating slowly on Y (0.12 rad/s) with a slight X wobble. Camera at `z = 7`. Starfield
behind, grid floor far below with a soft horizon fade. Bloom at its second-highest
intensity.

HTML overlay, centre-aligned, offset up by ~8vh:

- Eyebrow pill: `Windows · Free forever · Your own API key` — 11px, letter-spacing
  0.18em, uppercase, `--fg-faint`, inside a hairline rounded-full border.
- H1, Space Grotesk 600, `clamp(2.75rem, 8vw, 7rem)`, `line-height: 0.95`,
  `letter-spacing: -0.03em`:
  **"Vibe. Build. Anything."** — the third word carries the signature gradient as
  `background-clip: text`.
- Sub, Inter 400, `--fg-muted`, `max-width: 46ch`:
  "A desktop AI coding IDE that runs on your machine, edits your real files, and bills
  you nothing. Bring your own model key and keep every byte local."
- Primary button: **Download for Windows** with the version and size beneath it.
- Secondary text link: "Read the docs".
- Bottom-centre: a 24px scroll hint that fades out as progress passes 0.03.

### 3.2 The editor — `0.16 → 0.34`

3D: the mark slides left and shrinks; an **AppWindow** slab flies in from
`z = -6, x = +3` to `x = +1.6`, tilting from `rotY = 0.6` to `0.16`. It is a rounded
box with an emissive front face carrying a screenshot-like texture drawn to a canvas at
runtime: a title bar with three dots, a sidebar, a code column, and a chat column with
a violet send button. Two thin cyan "cursor" lines pulse on it.

HTML: right-aligned copy column, 44ch max.
Heading "Two ways to work." Body: Ask answers questions about the open workspace with
citations and no side effects. Build is an agent that reads, writes, runs commands and
reports what it actually did. Three checklist rows, each with a small gradient dot:
`Ask — grounded answers, zero writes`, `Build — plans, edits, verifies`,
`Every change diffed before it lands`.

### 3.3 Bring your own key — `0.34 → 0.52`

3D: an icosahedron **hub** at the centre with a wireframe overlay, and six small
**provider nodes** orbiting on a ring tilted 18°, each a glowing sphere trailing a
faint line to the hub. Ring rotation is scroll-linked, not time-linked, so scrolling
visibly spins it.

HTML: centred. Heading "Your key. Your models. Your bill."
Body: AXIOM ships with no subscription and no proxy. Point it at OpenAI, Anthropic,
Gemini, any OpenAI-compatible gateway, or a local Ollama server and it talks straight
to that endpoint. Keys are encrypted with the OS keychain and never leave the machine
except to the endpoint you configured.
Then a 3-up stat row in JetBrains Mono: `$0 / month`, `0 accounts required`,
`100% local files`.

### 3.4 Agent + terminal — `0.52 → 0.70`

3D: a **TerminalSlab** — a dark rounded plane, front-lit, with a runtime-drawn canvas
texture showing a prompt line, a command, and an `Exit Code: 0` badge in cyan. It
rises from `y = -2` and settles at `y = -0.3`, rotating from `rotX = 0.5` to `0.12`.

HTML: left-aligned copy. Heading "It runs the command, and shows you the output."
Body: When Build runs something, the transcript renders a real terminal block — the
command, the exit code, and the captured output, with credentials stripped out. No
guessing whether a step passed.
Below it, a static HTML replica of the command card (hairline border, mono command,
cyan `Exit Code: 0` pill, three lines of dimmed output) so the message lands even
before the reader looks at the 3D.

### 3.5 Trust and safety — `0.70 → 0.86`

3D: a **CheckpointStack** of five thin rounded planes fanning apart along Y as
progress advances, each with a hairline edge glow, the top one brightest.

HTML: centred, narrow. Heading "Nothing happens without you."
Four short rows: `Folders are trusted explicitly, once, by you.` /
`Commands, Git pushes and risky actions ask every time.` /
`Every edit is snapshotted, so any turn can be reverted.` /
`Local audit log you can read.`
One line of honest fine print in `--fg-faint`: "The installer is unsigned, so Windows
SmartScreen will warn on first run. The SHA-256 below is how you verify it."

### 3.6 Download — `0.86 → 1.00`

3D: the mark returns to centre, front-on (`rotY → 0`), scales up ~15%, bloom at
maximum. Starfield drift slows to a stop.

HTML: the **DownloadCard**, centred, `max-width: 34rem`:

- Heading "Download AXIOM"
- The primary `<a download>` button, full width.
- A metadata table in JetBrains Mono: File, Version, Size, SHA-256 (wrapped, with a
  copy button), Platform (`Windows 10/11 · x64`).
- A collapsible "Verify your download" block containing the exact command:
  `certutil -hashfile AXIOM-Setup-<version>-x64.exe SHA256`
- Requirements line: Windows 10 or 11, 64-bit · ~400 MB free disk · an API key from
  any supported provider, or Ollama for fully local use.

Then the footer: the mark, the tagline, and three columns — Product (Download, Docs),
Legal (Terms, Privacy), About (a one-paragraph description). No social icons unless
real URLs exist.

---

## 4. `lib/release.ts` — one source of truth

Every place that names the installer reads from here. If the version changes, exactly
one file changes.

```ts
export const RELEASE = {
  version: '1.0.9',
  fileName: 'AXIOM-Setup-1.0.9-x64.exe',
  downloadPath: '/downloads/AXIOM-Setup-1.0.9-x64.exe',
  bytes: 111411357,
  sha256: '<64 hex chars>',
  platform: 'Windows 10/11 · x64',
} as const;

export const prettySize = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
```

The size shown on the page must be **computed from `bytes`**, never typed by hand, and
`bytes` and `sha256` must be the real values of the real file in `public/downloads/`.
A download page that lies about a hash is worse than one with no hash at all.

---

## 5. Docs, Terms, Privacy

Three real routes (`/docs`, `/terms`, `/privacy`), not modals, each on the `--canvas`
background with no 3D behind it, a shared prose style (`max-width: 72ch`, generous
leading, gradient rules between sections), and a back link to `/`.

- **`/docs`** — genuinely useful: Install (including the SmartScreen step), First run,
  Configuring a provider (OpenAI / Anthropic / Gemini / OpenAI-compatible gateway /
  Ollama), Ask vs Build, Trusting a folder and granting edit permission, Reverting a
  change, Keyboard shortcuts, Where your data lives (exact `%APPDATA%` paths),
  Troubleshooting (SmartScreen, HTTP 401, HTTP 429, a model that returns 500,
  no models listed), Uninstalling.
- **`/terms`** — plain-language: licence to use, no warranty, you are responsible for
  what the AI writes and for the code it runs, third-party model providers are governed
  by their own terms and you pay them directly, unsigned build notice, no liability
  cap theatre — just a clear disclaimer.
- **`/privacy`** — the strong claim, stated precisely: no account, no telemetry by
  default, no analytics on the site, source code never sent anywhere except to the
  model endpoint the user configured, API keys encrypted at rest with the OS keychain
  and never transmitted to us because there is no "us" server, and an explicit list of
  what leaves the machine and when.

Write all three fully. Do not leave `Lorem ipsum`, `TODO`, or `[Your Company]`
placeholders. Where a real-world detail is genuinely unknown (a legal entity name, a
contact address), state it as "not applicable — this project has no company entity"
rather than inventing one.

---

## 6. Quality bar

- TypeScript strict. No `any`. `npm run build` completes with zero errors.
- Every interactive element is a real `<button>` or `<a>`, reachable by keyboard, with
  a visible focus ring (`outline: 2px solid #8B5CF6; outline-offset: 2px`).
- Text contrast at least 4.5:1 against its actual background. `--fg-faint` on
  `--void` is the floor — do not go dimmer.
- The canvas is `aria-hidden` and `pointer-events: none`; it is decoration, and the
  page must make complete sense with it removed.
- Mobile: the 3D scene stays but drops to `dpr={[1, 1.5]}`, the starfield halves its
  count, bloom is reduced, and every two-column section collapses to one column.
- No layout shift on font load: `display=swap` plus matching fallback metrics.
- No `console.log` in shipped code.
