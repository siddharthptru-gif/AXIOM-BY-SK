import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { BACKDROP_CROSSFADE_S, type BackdropMode } from '../lib/backdrop';
import type { ScrollState } from '../lib/useScrollProgress';

/**
 * The animated background field.
 *
 * A single full-screen quad drawn in clip space: the vertex shader ignores the camera
 * entirely, so the backdrop always covers the viewport no matter where the camera rig
 * has travelled. Depth test and write are off and `renderOrder` is far negative, so it
 * paints first and everything else in the scene sits on top of it.
 *
 * Two modes are evaluated every frame and mixed, which is what makes switching a true
 * 1200 ms crossfade rather than a cut. It costs one extra pattern evaluation only while
 * a transition is in flight — `uMix` reaches 1 and the source collapses to the target.
 *
 * The field is deliberately kept dim. Bloom in the composer triggers at a luminance of
 * 0.22, so a bright backdrop would smear the whole screen and drown the mark. Peak
 * accent here lands just under that, leaving the glow for the foreground.
 */

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // Clip-space quad: geometry is already -1..1, so skip the MVP transform.
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform vec2  uResolution;
  uniform int   uFrom;
  uniform int   uTo;
  uniform float uMix;
  uniform float uScroll;

  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p *= 2.02;
      a *= 0.5;
    }
    return v;
  }

  // 0 — Water Wave: domain-warped noise, slow and liquid.
  float waterWave(vec2 uv, float t) {
    vec2 p = uv * vec2(3.2, 2.1);
    vec2 q = vec2(fbm(p + t * 0.055), fbm(p + vec2(5.2, 1.3) - t * 0.045));
    float f = fbm(p + 3.0 * q + t * 0.03);
    return smoothstep(0.28, 0.92, f);
  }

  // 1 — Gridwave: a perspective grid with a travelling swell through it.
  float gridWave(vec2 uv, float t) {
    vec2 p = uv - 0.5;
    p.y += 0.36;
    float persp = 1.0 / max(abs(p.y), 0.022);
    vec2 g = vec2(p.x * persp * 0.55, persp * 0.85 + t * 0.42);
    g.y += sin(g.x * 1.55 + t * 0.85) * 0.42;
    vec2 cell = abs(fract(g) - 0.5);
    float line = 1.0 - min(min(cell.x, cell.y) * 2.0, 1.0);
    line = pow(line, 11.0);
    float horizon = smoothstep(0.0, 0.42, abs(p.y));
    return line * horizon;
  }

  // 2 — Light Tunnel: radial streaks receding toward the centre.
  float lightTunnel(vec2 uv, float t) {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
    float r = max(length(p), 0.0001);
    float a = atan(p.y, p.x);
    float streaks = 0.5 + 0.5 * sin(a * 13.0 + t * 0.75 + 2.1 / r);
    streaks = pow(streaks, 4.0);
    float depth = smoothstep(0.02, 0.78, r) * (1.0 - smoothstep(0.72, 1.4, r));
    return streaks * depth;
  }

  float patternAt(int mode, vec2 uv, float t) {
    if (mode == 1) return gridWave(uv, t);
    if (mode == 2) return lightTunnel(uv, t);
    return waterWave(uv, t);
  }

  void main() {
    float field = mix(
      patternAt(uFrom, vUv, uTime),
      patternAt(uTo, vUv, uTime),
      smoothstep(0.0, 1.0, uMix)
    );

    vec3 base   = vec3(0.020, 0.020, 0.039); // #05050A
    vec3 violet = vec3(0.545, 0.361, 0.965); // #8B5CF6
    vec3 blue   = vec3(0.231, 0.510, 0.965); // #3B82F6
    vec3 cyan   = vec3(0.133, 0.827, 0.933); // #22D3EE

    // The accent walks violet -> blue -> cyan up the screen and along the scroll, so
    // the palette travels with the page instead of sitting still.
    float ramp = clamp(vUv.y * 0.72 + uScroll * 0.55, 0.0, 1.0);
    vec3 accent = mix(violet, blue, smoothstep(0.0, 0.62, ramp));
    accent = mix(accent, cyan, smoothstep(0.52, 1.0, ramp));

    vec3 color = base + accent * field * 0.46;

    // Centre vignette: the type always needs somewhere dark to land.
    float d = length(vUv - vec2(0.5));
    color *= 1.0 - smoothstep(0.32, 0.98, d) * 0.6;

    // A trace of grain, which is what stops a wide gradient from banding.
    float grain = (hash(vUv * uResolution + fract(uTime)) - 0.5) * 0.016;

    gl_FragColor = vec4(color + grain, 1.0);
  }
`;

export function Backdrop({
  mode,
  scroll,
  reducedMotion,
}: {
  mode: BackdropMode;
  scroll: React.MutableRefObject<ScrollState>;
  reducedMotion: boolean;
}) {
  const material = useRef<THREE.ShaderMaterial>(null);
  const transition = useRef({ from: mode as number, to: mode as number, mix: 1 });

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uFrom: { value: mode as number },
      uTo: { value: mode as number },
      uMix: { value: 1 },
      uScroll: { value: 0 },
    }),
    // Built once; every value below is driven imperatively in useFrame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useFrame((state, delta) => {
    const node = material.current;
    if (!node) return;
    const store = transition.current;

    // A click mid-crossfade retargets from whatever was already incoming, so rapid
    // switching stays a fade instead of stacking three patterns.
    if (store.to !== mode) {
      store.from = store.to;
      store.to = mode;
      store.mix = reducedMotion ? 1 : 0;
    }
    if (store.mix < 1) {
      store.mix = Math.min(1, store.mix + delta / BACKDROP_CROSSFADE_S);
      if (store.mix >= 1) store.from = store.to;
    }

    node.uniforms.uFrom!.value = store.from;
    node.uniforms.uTo!.value = store.to;
    node.uniforms.uMix!.value = store.mix;
    node.uniforms.uScroll!.value = scroll.current.current;
    // Frozen clock under reduced motion: the pattern still renders, it just holds still.
    if (!reducedMotion) node.uniforms.uTime!.value += delta;
    (node.uniforms.uResolution!.value as THREE.Vector2).set(
      state.size.width * state.viewport.dpr,
      state.size.height * state.viewport.dpr,
    );
  });

  return (
    <mesh frustumCulled={false} renderOrder={-1000}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        ref={material}
        vertexShader={VERTEX}
        fragmentShader={FRAGMENT}
        uniforms={uniforms}
        depthTest={false}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}
