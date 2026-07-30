import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { ScrollState } from '../lib/useScrollProgress';
import { mapRange, windowProgress } from '../lib/math';

/**
 * The supporting cast of the scene. Each object owns one scroll window, animates
 * inside it, and hides itself outside it — so the whole page is one continuous 3D
 * shot rather than six disconnected canvases.
 *
 * Every texture here is drawn to an offscreen 2D canvas at runtime. That keeps the
 * site at zero image requests for the 3D layer, and means the "screenshots" inside the
 * scene stay sharp on a high-DPI display without shipping bitmaps.
 */

const VIOLET = '#8b5cf6';
const CYAN = '#22d3ee';

/** Shared helper: a canvas-backed texture with sane colour space and filtering. */
function useCanvasTexture(
  width: number,
  height: number,
  draw: (context: CanvasRenderingContext2D, w: number, h: number) => void,
): THREE.CanvasTexture | null {
  return useMemo(() => {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    draw(context, width, height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    return texture;
    // The draw function is defined inline per call site and never changes identity in
    // a way that should force a repaint, so the size pair is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + w, y, x + w, y + h, r);
  context.arcTo(x + w, y + h, x, y + h, r);
  context.arcTo(x, y + h, x, y, r);
  context.arcTo(x, y, x + w, y, r);
  context.closePath();
}

/* ------------------------------------------------------------------ starfield --- */

export function Starfield({
  scroll,
  reducedMotion,
  count,
}: {
  scroll: React.MutableRefObject<ScrollState>;
  reducedMotion: boolean;
  count: number;
}) {
  const points = useRef<THREE.Points>(null);

  const geometry = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const violet = new THREE.Color(VIOLET);
    const cyan = new THREE.Color(CYAN);
    const white = new THREE.Color('#ffffff');
    const mixed = new THREE.Color();
    for (let i = 0; i < count; i += 1) {
      // A hollow shell, so stars never spawn inside the camera.
      const radius = 14 + Math.random() * 26;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi) * 0.6;
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);

      const roll = Math.random();
      mixed.copy(white).lerp(roll > 0.55 ? violet : cyan, roll > 0.2 ? 0.75 : 0.15);
      colors[i * 3] = mixed.r;
      colors[i * 3 + 1] = mixed.g;
      colors[i * 3 + 2] = mixed.b;
    }
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    buffer.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return buffer;
  }, [count]);

  useFrame((_, delta) => {
    const node = points.current;
    if (!node || reducedMotion) return;
    // Drift slows to a stop over the last section, so the download card feels settled.
    const calm = 1 - windowProgress(scroll.current.current, 0.82, 1);
    node.rotation.y += delta * 0.012 * calm;
    node.rotation.x = scroll.current.current * 0.28;
  });

  return (
    <points ref={points} geometry={geometry}>
      <pointsMaterial
        size={0.085}
        sizeAttenuation
        vertexColors
        transparent
        opacity={0.85}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

/* ----------------------------------------------------------------- grid floor --- */

export function GridFloor({ scroll }: { scroll: React.MutableRefObject<ScrollState> }) {
  const group = useRef<THREE.Group>(null);

  const material = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: new THREE.Color('#3b2f7a'),
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
      }),
    [],
  );

  const geometry = useMemo(() => {
    const size = 40;
    const step = 1.6;
    const vertices: number[] = [];
    for (let i = -size; i <= size; i += step) {
      vertices.push(-size, 0, i, size, 0, i);
      vertices.push(i, 0, -size, i, 0, size);
    }
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    return buffer;
  }, []);

  useFrame(() => {
    const node = group.current;
    if (!node) return;
    // The floor rises as the page advances, which reads as descending toward it.
    node.position.y = -5.2 + scroll.current.current * 1.6;
    node.position.z = (scroll.current.current % 1) * 1.6;
  });

  return (
    <group ref={group} position={[0, -5.2, 0]}>
      <lineSegments geometry={geometry} material={material} />
    </group>
  );
}

/* ------------------------------------------------------------- the app window --- */

/** Draws a recognisable AXIOM workbench: title bar, sidebar, code column, chat column. */
function drawWorkbench(context: CanvasRenderingContext2D, w: number, h: number): void {
  context.fillStyle = '#0b0b14';
  context.fillRect(0, 0, w, h);

  // Title bar with traffic lights and a centred workspace name.
  context.fillStyle = '#12121c';
  context.fillRect(0, 0, w, 44);
  const dots = ['#f2797c', '#d6a84b', '#57c78d'];
  dots.forEach((color, index) => {
    context.fillStyle = color;
    context.beginPath();
    context.arc(24 + index * 22, 22, 6, 0, Math.PI * 2);
    context.fill();
  });
  context.fillStyle = '#6b6b85';
  context.font = '500 16px Inter, sans-serif';
  context.textAlign = 'center';
  context.fillText('AXIOM  —  my-project', w / 2, 28);
  context.textAlign = 'left';

  // Activity rail.
  context.fillStyle = '#0e0e18';
  context.fillRect(0, 44, 58, h - 44);
  for (let i = 0; i < 6; i += 1) {
    context.fillStyle = i === 1 ? VIOLET : '#2b2b44';
    roundRect(context, 19, 74 + i * 46, 20, 20, 5);
    context.fill();
  }

  // File tree.
  context.fillStyle = '#0d0d16';
  context.fillRect(58, 44, 210, h - 44);
  context.font = '400 15px "JetBrains Mono", monospace';
  const files = ['src/', '  main.tsx', '  game.ts', '  player.ts', 'index.html', 'README.md'];
  files.forEach((name, index) => {
    context.fillStyle = index === 2 ? '#e8e8f0' : '#6b6b85';
    context.fillText(name, 76, 84 + index * 30);
  });

  // Code column with syntax-ish colouring.
  const codeX = 288;
  const palette = [VIOLET, '#e8e8f0', CYAN, '#a0a0b8', VIOLET, '#e8e8f0', CYAN, '#a0a0b8'];
  const widths = [190, 300, 240, 150, 210, 330, 260, 180];
  for (let i = 0; i < 14; i += 1) {
    context.fillStyle = '#2a2a42';
    context.font = '400 13px "JetBrains Mono", monospace';
    context.fillText(String(i + 1).padStart(2, ' '), codeX - 26, 88 + i * 30);
    context.fillStyle = palette[i % palette.length] ?? '#a0a0b8';
    context.globalAlpha = 0.75;
    roundRect(context, codeX + (i % 3) * 18, 78 + i * 30, widths[i % widths.length] ?? 200, 9, 4);
    context.fill();
    context.globalAlpha = 1;
  }

  // Chat column, with a gradient send button so the AI surface is unmistakable.
  const chatX = w - 330;
  context.fillStyle = '#0d0d16';
  context.fillRect(chatX, 44, 330, h - 44);
  context.fillStyle = '#6b6b85';
  context.font = '600 13px Inter, sans-serif';
  context.fillText('BUILD', chatX + 22, 80);

  const bubbles: Array<[number, number, string]> = [
    [104, 220, '#1a1a28'],
    [150, 268, '#161626'],
    [212, 240, '#161626'],
  ];
  bubbles.forEach(([y, bw, color]) => {
    context.fillStyle = color;
    roundRect(context, chatX + 22, y, bw, 34, 9);
    context.fill();
  });

  // A command card echo, so the terminal story appears inside the editor too.
  context.strokeStyle = 'rgba(34, 211, 238, 0.4)';
  context.lineWidth = 1.5;
  roundRect(context, chatX + 22, 266, 286, 62, 9);
  context.stroke();
  context.fillStyle = CYAN;
  context.font = '500 13px "JetBrains Mono", monospace';
  context.fillText('npm run build', chatX + 36, 290);
  context.fillStyle = '#57c78d';
  context.fillText('Exit Code: 0', chatX + 36, 312);

  const gradient = context.createLinearGradient(chatX + 22, 0, chatX + 308, 0);
  gradient.addColorStop(0, VIOLET);
  gradient.addColorStop(1, CYAN);
  context.fillStyle = gradient;
  roundRect(context, chatX + 22, h - 74, 286, 42, 21);
  context.fill();
  context.fillStyle = '#06060c';
  context.font = '600 15px Inter, sans-serif';
  context.textAlign = 'center';
  context.fillText('Build it', chatX + 165, h - 47);
  context.textAlign = 'left';
}

export function AppWindow({ scroll }: { scroll: React.MutableRefObject<ScrollState> }) {
  const group = useRef<THREE.Group>(null);
  const texture = useCanvasTexture(1600, 1000, drawWorkbench);

  useFrame(() => {
    const node = group.current;
    if (!node) return;
    const t = windowProgress(scroll.current.current, 0.13, 0.32);
    const out = windowProgress(scroll.current.current, 0.32, 0.44);
    node.visible = t > 0.001 && out < 0.999;
    node.position.set(
      mapRange(t, 0, 1, 4.6, 1.55),
      mapRange(t, 0, 1, -1.1, 0.1) + out * 2.6,
      mapRange(t, 0, 1, -6.5, 0.2),
    );
    node.rotation.set(mapRange(t, 0, 1, 0.34, 0.04), mapRange(t, 0, 1, -0.85, -0.2), 0);
    node.scale.setScalar(mapRange(t, 0, 1, 0.6, 1) * (1 - out * 0.4));
  });

  return (
    <group ref={group} visible={false}>
      {/* Chassis */}
      <mesh position={[0, 0, -0.06]}>
        <boxGeometry args={[5.05, 3.22, 0.12]} />
        <meshPhysicalMaterial
          color="#0a0a12"
          metalness={0.6}
          roughness={0.32}
          clearcoat={0.6}
          emissive="#1a1440"
          emissiveIntensity={0.16}
        />
      </mesh>
      {/* Screen */}
      <mesh>
        <planeGeometry args={[4.85, 3.03]} />
        {texture ? (
          <meshBasicMaterial map={texture} toneMapped={false} />
        ) : (
          <meshBasicMaterial color="#0b0b14" />
        )}
      </mesh>
      {/* Edge light, which is what makes it read as a lit panel rather than a decal. */}
      <mesh position={[0, -1.68, 0]}>
        <planeGeometry args={[4.2, 0.03]} />
        <meshBasicMaterial color={CYAN} transparent opacity={0.55} toneMapped={false} />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------- provider ring --- */

export function ProviderRing({ scroll }: { scroll: React.MutableRefObject<ScrollState> }) {
  const group = useRef<THREE.Group>(null);
  const nodes = useMemo(
    () =>
      Array.from({ length: 6 }, (_, index) => {
        const angle = (index / 6) * Math.PI * 2;
        return {
          key: index,
          position: new THREE.Vector3(Math.cos(angle) * 2.6, 0, Math.sin(angle) * 2.6),
          color: index % 2 === 0 ? VIOLET : CYAN,
        };
      }),
    [],
  );

  useFrame(() => {
    const node = group.current;
    if (!node) return;
    const t = windowProgress(scroll.current.current, 0.32, 0.5);
    const out = windowProgress(scroll.current.current, 0.5, 0.6);
    node.visible = t > 0.001 && out < 0.999;
    node.position.set(0, mapRange(t, 0, 1, -3, 0.1) + out * 3.4, mapRange(t, 0, 1, -5, 0.6));
    // Ring rotation is scroll-linked, not time-linked, so scrolling visibly spins it.
    node.rotation.y = scroll.current.current * 9;
    node.rotation.x = 0.32;
    node.scale.setScalar(mapRange(t, 0, 1, 0.5, 1) * (1 - out * 0.5));
  });

  return (
    <group ref={group} visible={false}>
      <mesh>
        <icosahedronGeometry args={[0.95, 1]} />
        <meshPhysicalMaterial
          color="#1b1440"
          metalness={0.7}
          roughness={0.2}
          clearcoat={1}
          emissive={VIOLET}
          emissiveIntensity={0.5}
        />
      </mesh>
      <mesh>
        <icosahedronGeometry args={[1.32, 1]} />
        <meshBasicMaterial color={VIOLET} wireframe transparent opacity={0.22} toneMapped={false} />
      </mesh>
      {nodes.map((item) => (
        <group key={item.key} position={item.position}>
          <mesh>
            <sphereGeometry args={[0.19, 20, 20]} />
            <meshBasicMaterial color={item.color} toneMapped={false} />
          </mesh>
          <mesh scale={[1, 1, 1]}>
            <sphereGeometry args={[0.34, 16, 16]} />
            <meshBasicMaterial
              color={item.color}
              transparent
              opacity={0.14}
              toneMapped={false}
              depthWrite={false}
            />
          </mesh>
        </group>
      ))}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[2.6, 0.008, 8, 96]} />
        <meshBasicMaterial color={CYAN} transparent opacity={0.4} toneMapped={false} />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------- terminal slab --- */

function drawTerminal(context: CanvasRenderingContext2D, w: number, h: number): void {
  context.fillStyle = '#07070d';
  context.fillRect(0, 0, w, h);
  context.strokeStyle = 'rgba(35, 35, 58, 1)';
  context.lineWidth = 3;
  context.strokeRect(1.5, 1.5, w - 3, h - 3);

  context.font = '500 26px "JetBrains Mono", monospace';
  context.fillStyle = VIOLET;
  context.fillText('$', 40, 68);
  context.fillStyle = '#e8e8f0';
  context.fillText('npm run build', 74, 68);

  // Exit-code pill: the one thing a reader looks for.
  context.strokeStyle = 'rgba(87, 199, 141, 0.6)';
  context.lineWidth = 2;
  roundRect(context, w - 210, 42, 168, 38, 19);
  context.stroke();
  context.fillStyle = '#57c78d';
  context.font = '500 22px "JetBrains Mono", monospace';
  context.fillText('Exit Code: 0', w - 194, 68);

  context.font = '400 21px "JetBrains Mono", monospace';
  const lines = [
    'vite v5.4.11 building for production...',
    '\u2713 84 modules transformed.',
    'dist/index.html                 0.71 kB',
    'dist/assets/index-8f2c1a.js   184.20 kB',
    '\u2713 built in 1.94s',
  ];
  lines.forEach((line, index) => {
    context.fillStyle = index === 4 ? CYAN : '#a0a0b8';
    context.fillText(line, 40, 124 + index * 34);
  });
}

export function TerminalSlab({ scroll }: { scroll: React.MutableRefObject<ScrollState> }) {
  const group = useRef<THREE.Group>(null);
  const texture = useCanvasTexture(1200, 340, drawTerminal);

  useFrame(() => {
    const node = group.current;
    if (!node) return;
    const t = windowProgress(scroll.current.current, 0.5, 0.68);
    const out = windowProgress(scroll.current.current, 0.68, 0.78);
    node.visible = t > 0.001 && out < 0.999;
    node.position.set(
      mapRange(t, 0, 1, -3.4, -1.5),
      mapRange(t, 0, 1, -2.6, -0.2) + out * 2.8,
      mapRange(t, 0, 1, -4.5, 0.5),
    );
    node.rotation.set(mapRange(t, 0, 1, 0.62, 0.1), mapRange(t, 0, 1, 0.7, 0.24), 0);
    node.scale.setScalar(mapRange(t, 0, 1, 0.65, 1) * (1 - out * 0.4));
  });

  return (
    <group ref={group} visible={false}>
      <mesh position={[0, 0, -0.05]}>
        <boxGeometry args={[4.5, 1.35, 0.1]} />
        <meshPhysicalMaterial
          color="#0a0a12"
          metalness={0.55}
          roughness={0.35}
          emissive="#122036"
          emissiveIntensity={0.2}
        />
      </mesh>
      <mesh>
        <planeGeometry args={[4.34, 1.23]} />
        {texture ? (
          <meshBasicMaterial map={texture} toneMapped={false} />
        ) : (
          <meshBasicMaterial color="#07070d" />
        )}
      </mesh>
    </group>
  );
}

/* ---------------------------------------------------------- checkpoint stack --- */

export function CheckpointStack({ scroll }: { scroll: React.MutableRefObject<ScrollState> }) {
  const group = useRef<THREE.Group>(null);
  const planes = useRef<Array<THREE.Mesh | null>>([]);

  useFrame(() => {
    const node = group.current;
    if (!node) return;
    const t = windowProgress(scroll.current.current, 0.66, 0.86);
    const out = windowProgress(scroll.current.current, 0.86, 0.95);
    node.visible = t > 0.001 && out < 0.999;
    node.position.set(0, mapRange(t, 0, 1, -2.4, 0) + out * 3, mapRange(t, 0, 1, -5, 0.4));
    node.rotation.set(0.44, mapRange(t, 0, 1, 0.8, 0.3), 0);
    node.scale.setScalar(1 - out * 0.5);

    // The stack fans apart as the section advances: five saved states, not one.
    planes.current.forEach((plane, index) => {
      if (!plane) return;
      plane.position.y = index * (0.06 + t * 0.42);
      const material = plane.material as THREE.MeshBasicMaterial;
      material.opacity = 0.16 + (index / 4) * 0.5 * t;
    });
  });

  return (
    <group ref={group} visible={false}>
      {[0, 1, 2, 3, 4].map((index) => (
        <group key={index}>
          <mesh
            ref={(mesh) => {
              planes.current[index] = mesh;
            }}
            rotation={[-Math.PI / 2, 0, 0]}
          >
            <planeGeometry args={[3.4, 2.2]} />
            <meshBasicMaterial
              color={index === 4 ? CYAN : VIOLET}
              transparent
              opacity={0.2}
              side={THREE.DoubleSide}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}
