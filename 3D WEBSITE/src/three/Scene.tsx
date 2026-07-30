import { useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import type { ScrollState } from '../lib/useScrollProgress';
import { mapRange, windowProgress } from '../lib/math';
import { hasWebGL } from '../lib/webgl';
import { AxiomMark } from './AxiomMark';
import { AppWindow, CheckpointStack, ProviderRing, TerminalSlab } from './Objects';

/**
 * The 3D layer, on a transparent canvas over the video background.
 *
 * One canvas stays mounted for the whole route and ordinary page scroll drives a camera
 * rig through the scene. Keeping it mounted is what makes the motion continuous: nothing
 * re-initialises at a section boundary, so there is no hitch. The HTML above it is plain
 * scrolling markup, so anchors, keyboard paging and mobile momentum all still work.
 *
 * Because the video supplies the background, this layer deliberately draws NO field of
 * its own — no shader backdrop, no starfield, no grid floor. Those existed to fill an
 * empty black page; over footage they would only fight it. What is left is the lit
 * geometry: the mark and the per-section objects, plus the bloom that makes them read as
 * emitting light rather than being pasted on.
 *
 * The canvas is `aria-hidden` and `pointer-events: none`. It is decoration, and the page
 * is complete without it.
 */

/**
 * Post-processing over a TRANSPARENT canvas is the one part of this layer that depends
 * on the composer preserving alpha. It should: the render pass clears to (0,0,0,0) and
 * postprocessing's blend modes carry the input alpha through.
 *
 * If the video ever disappears behind a black rectangle, this is the cause — set this to
 * `false`. The mark keeps its emissive glow and the page stays correct; it just loses the
 * soft bloom halo around bright edges.
 */
const POST_PROCESSING = true;

/** The camera rides a short path so the scene is seen from changing angles. */
function CameraRig({
  scroll,
  reducedMotion,
}: {
  scroll: React.MutableRefObject<ScrollState>;
  reducedMotion: boolean;
}) {
  const { camera } = useThree();
  const target = useRef(new THREE.Vector3());

  useFrame(() => {
    const progress = scroll.current.current;
    if (reducedMotion) {
      camera.position.set(0, 0, 7);
      camera.lookAt(0, 0, 0);
      return;
    }

    // Piecewise path: pull back through the middle of the page, close in at the end.
    const dolly = mapRange(progress, 0, 0.55, 7, 9.4);
    const closeIn = windowProgress(progress, 0.8, 1);
    camera.position.x = Math.sin(progress * Math.PI * 1.35) * 1.5;
    camera.position.y = mapRange(progress, 0, 1, 0.35, -0.55);
    camera.position.z = dolly - closeIn * 2.6;

    // Look slightly ahead of centre so the framing never feels locked.
    target.current.set(
      Math.sin(progress * Math.PI) * 0.5 * (1 - closeIn),
      mapRange(progress, 0, 1, 0.1, -0.1),
      0,
    );
    camera.lookAt(target.current);
  });

  return null;
}

function SceneContents({
  scroll,
  reducedMotion,
  lowPower,
}: {
  scroll: React.MutableRefObject<ScrollState>;
  reducedMotion: boolean;
  lowPower: boolean;
}) {
  const key = useRef<THREE.PointLight>(null);

  useFrame(() => {
    // A single moving key light does most of the work of selling depth.
    const node = key.current;
    if (!node || reducedMotion) return;
    const progress = scroll.current.current;
    node.position.set(
      Math.cos(progress * Math.PI * 2) * 5,
      3.2 + Math.sin(progress * Math.PI * 2) * 1.4,
      4.5,
    );
  });

  return (
    <>
      <CameraRig scroll={scroll} reducedMotion={reducedMotion} />

      <ambientLight intensity={0.35} color="#8b7fd6" />
      <pointLight ref={key} position={[5, 3.2, 4.5]} intensity={70} color="#a78bfa" distance={26} />
      <pointLight position={[-5, -2, 3]} intensity={40} color="#22d3ee" distance={22} />
      <directionalLight position={[0, 6, 6]} intensity={0.7} color="#ffffff" />

      {/*
        The mark is a clearcoated metal, and metal with nothing to reflect renders dull
        and grey. This builds the environment map from light panels in-scene instead of
        fetching drei's hosted HDR — one fewer third-party request, and it still works
        with no network at all. `frames={1}` bakes it once; it never needs to update.
      */}
      <Environment resolution={256} frames={1} background={false}>
        <Lightformer
          form="rect"
          intensity={3}
          color="#a78bfa"
          position={[-4, 3, 5]}
          scale={[8, 8, 1]}
        />
        <Lightformer
          form="rect"
          intensity={2.2}
          color="#22d3ee"
          position={[5, -2, 4]}
          scale={[7, 7, 1]}
        />
        <Lightformer
          form="circle"
          intensity={1.4}
          color="#ffffff"
          position={[0, 6, -3]}
          scale={[5, 5, 1]}
        />
      </Environment>

      <AxiomMark scroll={scroll} reducedMotion={reducedMotion} />
      <AppWindow scroll={scroll} />
      <ProviderRing scroll={scroll} />
      <TerminalSlab scroll={scroll} />
      <CheckpointStack scroll={scroll} />

      {POST_PROCESSING ? (
        <EffectComposer enableNormalPass={false}>
          <Bloom
            intensity={lowPower ? 0.55 : 0.95}
            luminanceThreshold={0.22}
            luminanceSmoothing={0.4}
            mipmapBlur
          />
          {/* Light touch: the HTML scrim above the video already darkens the edges. */}
          <Vignette offset={0.42} darkness={0.34} />
        </EffectComposer>
      ) : null}
    </>
  );
}

export function Scene({
  scroll,
  reducedMotion,
}: {
  scroll: React.MutableRefObject<ScrollState>;
  reducedMotion: boolean;
}) {
  // No WebGL: render nothing. The video background is already there, so unlike the
  // all-black original there is no empty page to fill in.
  if (!hasWebGL()) return null;

  const lowPower =
    typeof window !== 'undefined' &&
    (window.innerWidth < 900 || (navigator.hardwareConcurrency ?? 8) <= 4);

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[2]">
      <Canvas
        dpr={lowPower ? [1, 1.5] : [1, 2]}
        // `alpha: true` plus a fully transparent clear is what lets the video show
        // through. Anything opaque here would hide the background completely.
        gl={{
          antialias: !lowPower,
          powerPreference: 'high-performance',
          alpha: true,
          premultipliedAlpha: false,
        }}
        onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
        camera={{ position: [0, 0.35, 7], fov: 42, near: 0.1, far: 90 }}
        // Nothing in the scene is interactive, so skip pointer raycasting entirely.
        events={undefined}
      >
        <SceneContents scroll={scroll} reducedMotion={reducedMotion} lowPower={lowPower} />
      </Canvas>
    </div>
  );
}
