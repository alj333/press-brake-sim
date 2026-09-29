/** Exact machine-frame collision locations rendered as visual-only markers. */
import { Billboard, Html } from '@react-three/drei';
import type { CollisionReport } from '../core/types';

export interface CollisionMarkersProps {
  collisions: readonly CollisionReport[];
}

export function CollisionMarkers({ collisions }: CollisionMarkersProps) {
  return (
    <group name="collision-markers">
      {collisions.map((collision, index) => {
        const radius = Math.max(4, Math.min(11, 4 + collision.depth * 0.9));
        const colour = collision.severity === 'error' ? '#ef233c' : '#f59e0b';
        return (
          <group
            key={`${collision.with}:${collision.atFraction}:${index}`}
            name={`collision-marker:${collision.with}:${index}`}
            position={[collision.location.x, collision.location.y, collision.location.z]}
          >
            <mesh renderOrder={30}>
              <sphereGeometry args={[radius * 0.58, 16, 12]} />
              <meshBasicMaterial color={colour} transparent opacity={0.96} depthTest={false} />
            </mesh>
            <Billboard follow>
              <mesh renderOrder={31}>
                <torusGeometry args={[radius * 1.35, Math.max(0.8, radius * 0.13), 8, 28]} />
                <meshBasicMaterial color={colour} transparent opacity={0.95} depthTest={false} />
              </mesh>
            </Billboard>
            <Html center zIndexRange={[8, 0]} style={{ pointerEvents: 'none' }}>
              <span
                className={`pbsim-collision-pin pbsim-collision-pin-${collision.severity}`}
                data-testid="sim-collision-pin"
                aria-hidden="true"
              />
            </Html>
          </group>
        );
      })}
    </group>
  );
}
