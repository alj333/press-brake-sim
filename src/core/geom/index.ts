/**
 * core-geometry / geom — pure 2D/3D geometry (no DOM, no three.js).
 * `vec2`, `vec3`, `mat4` are namespaces; polygon/arc/3D helpers are named exports.
 */
export * as vec2 from './vec2';
export * as vec3 from './vec3';
export * as mat4 from './mat4';
export {
  signedArea, area, isCCW, ensureCCW, ensureCW, centroid, bounds, pointSegmentDistance, distanceToBoundary,
  classifyPoint, pointInPolygon, segmentIntersect, segmentDistance, polygonsIntersect, penetrationDepth,
  polygonDistance, dedupe, simplifyCollinear, splitPolygonByLine, clipPolygonByHalfPlane, sharedBoundaryLength,
  convexHull, thickenSegment, affineIdentity, affineTranslation, affineRotation, affineMirrorX, affineMultiply,
  affineApply, transformPolygon2,
} from './polygon';
export type { PointClass, SegmentHit, Affine2 } from './polygon';
export { unionAdjacentPolygons } from './merge';
export type { MergedRegion } from './merge';
export { arcStepDeg, arcToPoints, bulgeArcToPoints } from './arc';
export { transformPolygon, polygonNormal, planeBasis, projectToXY, bounds3, clipToZ } from './polygon3';
export { EPS } from './vec2';
