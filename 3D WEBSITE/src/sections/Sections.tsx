import { Link } from 'react-router-dom';
import { Reveal } from '../components/Reveal';
import { DownloadCard } from '../components/DownloadCard';
import { SplitText } from '../components/SplitText';
import { BackdropSwitcher } from '../components/BackdropSwitcher';
import type { BackdropMode } from '../lib/backdrop';
import { RELEASE, RELEASE_SIZE } from '../lib/release';

/**
 * The six HTML sections that scroll over the 3D scene.
 *
 * Each one is deliberately narrow and text-light. The scene is doing the spectacle, so
 * the copy's job is to be legible on top of a moving background and to say something
 * true — a marketing page for a developer tool loses more from one unverifiable claim
 * than it gains from three adjectives.
 */

function Dot() {
  return (
    <span
      aria-hidden="true"
      className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: 'linear-gradient(100deg, #8b5cf6, #22d3ee)' }}
    />
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-3 text-sm leading-relaxed text-fg-muted">
      <Dot />
      <span>{children}</span>
    </li>
  );
}

function SectionShell({
  id,
  children,
  align = 'center',
}: {
  id: string;
  children: React.ReactNode;
  align?: 'center' | 'left' | 'right';
}) {
  const justify =
    align === 'left' ? 'md:justify-start' : align === 'right' ? 'md:justify-end' : 'justify-center';
  return (
    <section
      id={id}
      className={`relative flex min-h-screen items-center ${justify} px-6 py-24 md:px-12`}
    >
      <div className="mx-auto w-full max-w-7xl">
        <div
          className={
            align === 'center'
              ? 'flex justify-center'
              : align === 'right'
                ? 'flex justify-end'
                : 'flex justify-start'
          }
        >
          {children}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------- hero --- */

export function Hero({
  mode,
  onModeChange,
}: {
  mode: BackdropMode;
  onModeChange: (mode: BackdropMode) => void;
}) {
  return (
    <section
      id="top"
      className="relative z-[2] mx-auto flex min-h-screen max-w-[1340px] flex-col items-center justify-center px-6 pb-24 pt-32 text-center"
    >
      <div className="text-scrim flex flex-col items-center">
        <Reveal>
          <span className="eyebrow">Windows · Free forever · Your own key</span>
        </Reveal>

        <Reveal delay={0.08}>
          <h1 className="text-lift mt-7 font-display font-semibold leading-[0.95] tracking-[-0.03em] text-fg-max [font-size:clamp(2.75rem,8vw,7rem)]">
            <SplitText text="Vibe. Build." />
            <br />
            <SplitText text="Anything." gradient />
          </h1>
        </Reveal>

        <Reveal delay={0.16}>
          <p className="mx-auto mt-7 max-w-[46ch] text-base leading-relaxed text-fg-muted">
            A desktop AI coding IDE that runs on your machine, edits your real files, and bills you
            nothing. Bring your own model key and keep every byte local.
          </p>
        </Reveal>
      </div>

      <Reveal delay={0.24}>
        <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
          <a className="btn-primary" href={RELEASE.downloadPath} download>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 19h16"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Download for Windows
          </a>
          <Link className="btn-ghost" to="/docs">
            Read the docs
          </Link>
        </div>
      </Reveal>

      <Reveal delay={0.32}>
        <p className="mt-5 font-mono text-[11px] text-fg-faint">
          v{RELEASE.version} · {RELEASE_SIZE} · x64 installer
        </p>
      </Reveal>

      <Reveal delay={0.4}>
        <div className="mt-14">
          <BackdropSwitcher mode={mode} onChange={onModeChange} />
        </div>
      </Reveal>

      <div
        aria-hidden="true"
        className="absolute bottom-10 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2"
      >
        <span className="text-[10px] uppercase tracking-[0.24em] text-fg-faint">Scroll</span>
        <span className="scroll-hint-dot h-8 w-[1px] bg-gradient-to-b from-violet to-transparent" />
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------- editor --- */

export function EditorSection() {
  return (
    <SectionShell id="editor" align="left">
      <div className="text-scrim max-w-[44ch]">
        <Reveal>
          <span className="eyebrow">The workbench</span>
          <h2 className="text-lift mt-6 font-display text-4xl font-semibold leading-tight tracking-[-0.02em] text-fg-max md:text-5xl">
            <SplitText text="Two ways to work." />
          </h2>
          <p className="mt-5 text-sm leading-relaxed text-fg-muted md:text-base">
            <strong className="text-fg">Ask</strong> answers questions about the workspace you have
            open, cites the files it used, and changes nothing.{' '}
            <strong className="text-fg">Build</strong> is an agent: it reads, writes, runs commands,
            and reports what it actually did.
          </p>
          <ul className="mt-7 flex flex-col gap-3">
            <Bullet>Ask — grounded answers, zero writes</Bullet>
            <Bullet>Build — plans, edits files, runs verification</Bullet>
            <Bullet>Every change diffed before it lands, and revertible after</Bullet>
          </ul>
        </Reveal>
      </div>
    </SectionShell>
  );
}

/* ---------------------------------------------------------------------- byok --- */

const STATS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '$0', label: 'per month' },
  { value: '0', label: 'accounts required' },
  { value: '100%', label: 'local files' },
];

export function ByokSection() {
  return (
    <SectionShell id="byok">
      <div className="text-scrim max-w-[52ch] text-center">
        <Reveal>
          <span className="eyebrow">Bring your own key</span>
          <h2 className="text-lift mt-6 font-display text-4xl font-semibold leading-tight tracking-[-0.02em] text-fg-max md:text-5xl">
            <SplitText text="Your key. Your models." />
            <br />
            <SplitText text="Your bill." gradient />
          </h2>
          <p className="mt-5 text-sm leading-relaxed text-fg-muted md:text-base">
            AXIOM ships with no subscription and no proxy in the middle. Point it at OpenAI,
            Anthropic, Gemini, any OpenAI-compatible gateway, or a local Ollama server, and it talks
            straight to that endpoint. Keys are encrypted with the OS keychain and never leave your
            machine except to the endpoint you configured.
          </p>
        </Reveal>

        <Reveal delay={0.12}>
          <div className="mt-11 grid grid-cols-3 gap-4">
            {STATS.map((stat) => (
              <div key={stat.label} className="glass rounded-xl px-3 py-5">
                <div className="font-mono text-2xl font-medium grad-text md:text-3xl">
                  {stat.value}
                </div>
                <div className="mt-1.5 text-[11px] uppercase tracking-[0.14em] text-fg-faint">
                  {stat.label}
                </div>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </SectionShell>
  );
}

/* ------------------------------------------------------------------ terminal --- */

export function AgentSection() {
  return (
    <SectionShell id="agent" align="right">
      <div className="text-scrim max-w-[46ch]">
        <Reveal>
          <span className="eyebrow">Agent + terminal</span>
          <h2 className="text-lift mt-6 font-display text-4xl font-semibold leading-tight tracking-[-0.02em] text-fg-max md:text-5xl">
            <SplitText text="It runs the command, and shows you the output." />
          </h2>
          <p className="mt-5 text-sm leading-relaxed text-fg-muted md:text-base">
            When Build runs something, the transcript renders a real terminal block: the exact
            command, the exit code, and the captured output with credentials stripped out. No
            guessing whether a step passed.
          </p>
        </Reveal>

        <Reveal delay={0.14}>
          <ul className="mt-7 flex flex-col gap-3">
            <Bullet>The exact command, not a paraphrase of it</Bullet>
            <Bullet>The exit code, so a failure is never silent</Bullet>
            <Bullet>The captured output, with credentials stripped out</Bullet>
          </ul>
        </Reveal>
      </div>
    </SectionShell>
  );
}

/* -------------------------------------------------------------------- safety --- */

const SAFETY: ReadonlyArray<string> = [
  'Folders are trusted explicitly, once, by you.',
  'Commands, Git pushes and risky actions ask every single time.',
  'Every edit is snapshotted, so any turn can be reverted.',
  'A local audit log you can actually read.',
];

export function SafetySection() {
  return (
    <SectionShell id="safety">
      <div className="text-scrim max-w-[46ch] text-center">
        <Reveal>
          <span className="eyebrow">Trust and safety</span>
          <h2 className="text-lift mt-6 font-display text-4xl font-semibold leading-tight tracking-[-0.02em] text-fg-max md:text-5xl">
            <SplitText text="Nothing happens without you." />
          </h2>
        </Reveal>

        <Reveal delay={0.12}>
          <ul className="mx-auto mt-8 flex max-w-[40ch] flex-col gap-3 text-left">
            {SAFETY.map((item) => (
              <Bullet key={item}>{item}</Bullet>
            ))}
          </ul>
        </Reveal>

        <Reveal delay={0.2}>
          <p className="mx-auto mt-9 max-w-[42ch] text-xs leading-relaxed text-fg-faint">
            The installer is unsigned, so Windows SmartScreen will warn on first run. The SHA-256 on
            the download card is how you verify it is the file we published.
          </p>
        </Reveal>
      </div>
    </SectionShell>
  );
}

/* ------------------------------------------------------------------ download --- */

export function DownloadSection() {
  return (
    <SectionShell id="download">
      <div className="flex w-full justify-center">
        <Reveal className="flex w-full justify-center">
          <DownloadCard />
        </Reveal>
      </div>
    </SectionShell>
  );
}
