import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { ScrollState } from '../lib/useScrollProgress';
import { mapRange, windowProgress } from '../lib/math';

/**
 * The AXIOM mark as real extruded geometry.
 *
 * Built procedurally from 2D outlines rather than loaded from a model or an image,
 * for three reasons: it stays crisp at any zoom, it costs no network request, and it
 * can be lit and bloomed like a physical object — which is what makes the hero read
 * as three-dimensional instead of a spinning picture of a logo.
 *
 * The mark is two blades meeting at an apex plus a crossbar. The left blade carries
 * the violet -> magenta gradient, the right blade blue -> cyan, exactly as in the
 * product icon. The gradient is baked into vertex colours from each blade's own Y
 * extent, so one material renders a true vertical ramp with no texture.
 */

const BEVEL = {
  bevelEnabled: true,
  bevelThickness: 0.045,
  bevelSize: 0.04,
  bevelSegments: 3,
  curveSegments: 4,
  depth: 0.42,
} as const;

function shapeFrom(points: readonly [number, number][]): THREE.Shape {
  const shape = new THREE.Shape();
  const [first, ...rest] = points;
  if (!first) return shape;
  shape.moveTo(first[0], first[1]);
  for (const [x, y] of rest) shape.lineTo(x, y);
  shape.closePath();
  return shape;
}

/**
 * Paint a vertical gradient into the geometry's vertex colours, then centre it so the
 * whole mark rotates about its own middle rather than about the origin of the plane
 * the outlines were drawn on.
 */
function buildBlade(
  points: readonly [number, number][],
  from: THREE.ColorRepresentation,
  to: THREE.ColorRepresentation,
): THREE.BufferGeometry {
  const geometry = new THREE.ExtrudeGeometry(shapeFrom(points), BEVEL);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const position = geometry.getAttribute('position');
  const minY = box?.min.y ?? 0;
  const maxY = box?.max.y ?? 1;
  const span = maxY - minY || 1;

  const low = new THREE.Color(from);
  const high = new THREE.Color(to);
  const mixed = new THREE.Color();
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i += 1) {
    const t = (position.getY(i) - minY) / span;
    mixed.copy(low).lerp(high, t);
    colors[i * 3] = mixed.r;
    colors[i * 3 + 1] = mixed.g;
    colors[i * 3 + 2] = mixed.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Left blade: bottom-left foot rising to the apex. Violet at the top, magenta at the foot. */
const LEFT_BLADE: readonly [number, number][] = [
  [-1.5, -1.5],
  [-0.62, -1.5],
  [0.34, 1.52],
  [-0.16, 1.52],
];

/** Right blade: apex down to the bottom-right foot, with the notch from the icon. */
const RIGHT_BLADE: readonly [number, number][] = [
  [0.2, 1.05],
  [0.66, 1.05],
  [1.5, -1.5],
  [0.78, -1.5],
  [0.52, -0.3],
  [0.34, -0.3],
];

/** Crossbar: the horizontal slab that closes the A. */
const CROSSBAR: readonly [number, number][] = [
  [-0.5, -0.62],
  [0.58, -0.62],
  [0.44, -1.06],
  [-0.64, -1.06],
];

export function AxiomMark({
  scroll,
  reducedMotion,
}: {
  scroll: React.MutableRefObject<ScrollState>;
  reducedMotion: boolean;
}) {
  const group = useRef<THREE.Group>(null);

  const geometries = useMemo(
    () => ({
      left: buildBlade(LEFT_BLADE, '#c026d3', '#a78bfa'),
      right: buildBlade(RIGHT_BLADE, '#3b82f6', '#67e8f9'),
      bar: buildBlade(CROSSBAR, '#7c3aed', '#4f7ef8'),
    }),
    [],
  );

  useFrame((_, delta) => {
    const node = group.current;
    if (!node) return;
    const progress = scroll.current.current;

    // Hero: centred and dominant. Middle of the page: pushed aside and smaller so the
    // scene's other objects lead. Final section: back to centre, front-on, larger.
    const exit = windowProgress(progress, 0.1, 0.3);
    const ret = windowProgress(progress, 0.8, 0.96);

    node.position.x = -2.35 * exit + 2.35 * ret;
    node.position.y = 0.28 * exit - 0.28 * ret;
    node.scale.setScalar(1 - 0.34 * exit + 0.42 * ret);

    if (reducedMotion) {
      node.rotation.set(0, -0.35 * exit * (1 - ret), 0);
      return;
    }

    // Idle spin, plus a scroll-linked yaw so scrolling visibly turns the object.
    node.rotation.y += delta * 0.12;
    node.rotation.y = THREE.MathUtils.lerp(
      node.rotation.y,
      mapRange(progress, 0.8, 1, node.rotation.y, 0),
      ret * 0.08,
    );
    node.rotation.x = Math.sin(progress * Math.PI * 2) * 0.14 + scroll.current.velocity * 2.4;
    node.rotation.z = -scroll.current.velocity * 1.4;
  });

  return (
    <group ref={group} position={[0, 0.28, 0]}>
      {(['left', 'right', 'bar'] as const).map((key) => (
        <mesh key={key} geometry={geometries[key]} castShadow={false} receiveShadow={false}>
          <meshPhysicalMaterial
            vertexColors
            metalness={0.42}
            roughness={0.22}
            clearcoat={1}
            clearcoatRoughness={0.14}
            reflectivity={0.75}
            emissive="#3d2a86"
            emissiveIntensity={0.34}
            envMapIntensity={1.1}
          />
        </mesh>
      ))}
    </group>
  );
}
