/** Accessible SVG comparison of the exact current and proposed die profiles. */
import { useId } from 'react';
import type { ToolGeometryComparison } from '../../core/planner';
import type { Vec2 } from '../../core/types';
import { fmt } from '../format';

export interface ToolChangeGraphicProps {
  geometry: ToolGeometryComparison;
  title: string;
  description: string;
  currentLabel: string;
  proposedLabel: string;
  collisionLabel: string;
  removedLabel: string;
  testId?: string;
}

interface ViewTransform {
  point(point: Vec2): string;
  x(value: number): number;
  y(value: number): number;
  scale: number;
}

function bounds(points: readonly Vec2[]): { minX: number; maxX: number; minY: number; maxY: number } {
  return {
    minX: Math.min(...points.map(point => point.x)),
    maxX: Math.max(...points.map(point => point.x)),
    minY: Math.min(...points.map(point => point.y)),
    maxY: Math.max(...points.map(point => point.y)),
  };
}

function transform(points: readonly Vec2[]): ViewTransform {
  const box = bounds(points);
  const margin = 7;
  const minX = box.minX - margin, maxX = box.maxX + margin;
  const minY = box.minY - 15, maxY = box.maxY + 11;
  const scale = Math.min(440 / Math.max(1, maxX - minX), 190 / Math.max(1, maxY - minY));
  const ox = 40 + (440 - (maxX - minX) * scale) / 2;
  const oy = 18 + (190 - (maxY - minY) * scale) / 2;
  return {
    x: value => ox + (value - minX) * scale,
    y: value => oy + (maxY - value) * scale,
    point: point => `${ox + (point.x - minX) * scale},${oy + (maxY - point.y) * scale}`,
    scale,
  };
}

export function ToolChangeGraphic({ geometry, title, description, currentLabel, proposedLabel, collisionLabel, removedLabel, testId = 'guidance-graphic' }: ToolChangeGraphicProps) {
  const rawId = useId();
  const id = rawId.replace(/[^a-zA-Z0-9_-]/g, '');
  const currentPoints = geometry.current.profile.points;
  const proposedPoints = geometry.proposed.profile.points;
  const collision = geometry.collision ? { x: geometry.collision.x, y: geometry.collision.y } : null;
  const all = [...currentPoints, ...proposedPoints, ...(collision ? [collision] : [])];
  const tx = transform(all);
  const currentHalf = geometry.current.bodyWidth / 2;
  const proposedHalf = geometry.proposed.bodyWidth / 2;
  const dimensionY = Math.min(...all.map(point => point.y)) - 8;
  const collisionSize = 4;

  return (
    <svg
      className="tool-change-graphic"
      viewBox="0 0 520 250"
      role="img"
      aria-labelledby={`${id}-title ${id}-description`}
      data-testid={testId}
    >
      <title id={`${id}-title`}>{title}</title>
      <desc id={`${id}-description`}>{description}</desc>
      <defs>
        <pattern id={`${id}-hatch`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="7" className="tool-change-hatch-line" />
        </pattern>
        <clipPath id={`${id}-current-clip`}>
          <polygon points={currentPoints.map(tx.point).join(' ')} />
        </clipPath>
        <marker id={`${id}-arrow`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="tool-change-arrow" />
        </marker>
      </defs>

      <line x1={tx.x(0)} y1={tx.y(2)} x2={tx.x(0)} y2={tx.y(dimensionY - 2)} className="tool-change-centreline" />
      <polygon points={currentPoints.map(tx.point).join(' ')} className="tool-change-current" data-testid="graphic-current-profile" />
      <g clipPath={`url(#${id}-current-clip)`} data-testid="graphic-required-envelope">
        <rect x={tx.x(-currentHalf)} y="0" width={Math.max(0, tx.x(-proposedHalf) - tx.x(-currentHalf))} height="250" fill={`url(#${id}-hatch)`} />
        <rect x={tx.x(proposedHalf)} y="0" width={Math.max(0, tx.x(currentHalf) - tx.x(proposedHalf))} height="250" fill={`url(#${id}-hatch)`} />
      </g>
      <polygon points={proposedPoints.map(tx.point).join(' ')} className="tool-change-proposed" data-testid="graphic-proposed-profile" />

      {collision && (
        <g data-testid="graphic-collision-marker">
          <line x1={tx.x(collision.x) - collisionSize} y1={tx.y(collision.y) - collisionSize} x2={tx.x(collision.x) + collisionSize} y2={tx.y(collision.y) + collisionSize} className="tool-change-collision" />
          <line x1={tx.x(collision.x) + collisionSize} y1={tx.y(collision.y) - collisionSize} x2={tx.x(collision.x) - collisionSize} y2={tx.y(collision.y) + collisionSize} className="tool-change-collision" />
          <text x={tx.x(collision.x) + 7} y={tx.y(collision.y) - 6} className="tool-change-collision-label">{collisionLabel}</text>
        </g>
      )}

      <g data-testid="graphic-dimension-body-width">
        <line
          x1={tx.x(-currentHalf)} y1={tx.y(dimensionY)} x2={tx.x(currentHalf)} y2={tx.y(dimensionY)}
          className="tool-change-dimension" markerStart={`url(#${id}-arrow)`} markerEnd={`url(#${id}-arrow)`}
        />
        <text x={tx.x(0)} y={tx.y(dimensionY) - 5} textAnchor="middle" className="tool-change-dimension-label">
          {currentLabel}: {fmt(geometry.current.bodyWidth, 1)} mm
        </text>
        <line
          x1={tx.x(-proposedHalf)} y1={tx.y(dimensionY - 5)} x2={tx.x(proposedHalf)} y2={tx.y(dimensionY - 5)}
          className="tool-change-dimension tool-change-dimension-proposed" markerStart={`url(#${id}-arrow)`} markerEnd={`url(#${id}-arrow)`}
        />
        <text x={tx.x(0)} y={tx.y(dimensionY - 5) + 15} textAnchor="middle" className="tool-change-dimension-label tool-change-dimension-label-proposed">
          {proposedLabel}: {fmt(geometry.proposed.bodyWidth, 1)} mm
        </text>
      </g>

      <g className="tool-change-legend">
        <rect x="35" y="226" width="16" height="8" className="tool-change-current" />
        <text x="56" y="234">{currentLabel}</text>
        <line x1="190" y1="230" x2="210" y2="230" className="tool-change-proposed" />
        <text x="216" y="234">{proposedLabel}</text>
        <rect x="370" y="226" width="16" height="8" fill={`url(#${id}-hatch)`} />
        <text x="392" y="234">{removedLabel}</text>
      </g>
    </svg>
  );
}
