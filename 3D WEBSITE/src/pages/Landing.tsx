import { useState } from 'react';
import { VideoBackdrop } from '../components/VideoBackdrop';
import type { BackdropMode } from '../lib/backdrop';
import {
  AgentSection,
  ByokSection,
  DownloadSection,
  EditorSection,
  Hero,
  SafetySection,
} from '../sections/Sections';

/**
 * The landing route: a crossfading video background, a scrim to protect the type, and
 * the copy on top. Three layers, nothing else.
 *
 *   z-0   the crossfading video background
 *   z-1   a tint-and-scrim pass, so type keeps its contrast over moving footage
 *   z-10  the HTML content
 *
 * The WebGL layer that used to sit between them is gone. Running a 3D scene with bloom
 * on top of three simultaneously decoding videos meant two things competing for the same
 * GPU every frame, and the visible symptom was the geometry flickering. Nothing about
 * that is fixable by tuning it down — the page only ever needed one of the two. The
 * scene is still in `src/three/`, unwired, if it is ever wanted back on a static
 * background.
 */
export function Landing() {
  const [backdropMode, setBackdropMode] = useState<BackdropMode>(0);

  return (
    <>
      <VideoBackdrop mode={backdropMode} />

      {/*
        The reference used a flat `bg-black/10` over video. A 10% tint is nowhere near
        enough to hold a 4.5:1 contrast ratio when a bright streak drifts under body
        copy, so this is a tint plus a vertical scrim: darkest at the top and bottom
        where the nav and the footer sit, and slightly lifted through the middle.

        With the 3D layer gone the type is the only thing on this page, so the scrim
        carries a little more weight than it did before.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-[1] bg-void/30"
        style={{
          backgroundImage:
            'linear-gradient(180deg, rgba(5,5,10,0.78) 0%, rgba(5,5,10,0.3) 20%, rgba(5,5,10,0.24) 50%, rgba(5,5,10,0.4) 80%, rgba(5,5,10,0.85) 100%)',
        }}
      />

      <main className="relative z-10">
        <Hero mode={backdropMode} onModeChange={setBackdropMode} />
        <EditorSection />
        <ByokSection />
        <AgentSection />
        <SafetySection />
        <DownloadSection />
      </main>
    </>
  );
}
