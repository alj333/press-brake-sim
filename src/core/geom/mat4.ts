/**
 * 4×4 transforms in three.js column-major layout WITHOUT importing three.
 * Element (row r, col c) lives at m[c*4 + r]; translation at m[12], m[13], m[14].
 * Imported as a namespace: `import { mat4 } from '../geom'`.
 */
import type { Mat4, Quat, Vec3 } from '../types';

export function identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function clone(m: Mat4): Mat4 { return m.slice(); }

/** a·b — applies b first, then a (three.js `a.clone().multiply(b)`). */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out: Mat4 = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
    }
  }
  return out;
}

/** Fold left: multiplyAll(a, b, c) = a·b·c (c applied first). */
export function multiplyAll(...ms: Mat4[]): Mat4 {
  let out = identity();
  for (const m of ms) out = multiply(out, m);
  return out;
}

export function translation(v: Vec3): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v.x, v.y, v.z, 1];
}

export function translationXYZ(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

export function scaling(sx: number, sy: number, sz: number): Mat4 {
  return [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1];
}

/** Rotation about an axis through the origin (right-hand rule), angle in degrees. */
export function fromAxisAngle(dir: Vec3, deg: number): Mat4 {
  const l = Math.hypot(dir.x, dir.y, dir.z);
  if (l === 0) return identity();
  const x = dir.x / l, y = dir.y / l, z = dir.z / l;
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), t = 1 - c;
  // Row-major Rodrigues matrix R[row][col], stored column-major.
  return [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,      // column 0 = R[.][0]
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,      // column 1
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,      // column 2
    0, 0, 0, 1,
  ];
}

/** Rotation about the axis through `point` along `dir` = T(point)·R·T(−point). */
export function rotationAxisAngle(point: Vec3, dir: Vec3, deg: number): Mat4 {
  const R = fromAxisAngle(dir, deg);
  // T(p)·R·T(−p): rotation part R, translation p − R·p
  const rp = applyToDir(R, point);
  R[12] = point.x - rp.x;
  R[13] = point.y - rp.y;
  R[14] = point.z - rp.z;
  return R;
}

export function applyToPoint(m: Mat4, p: Vec3): Vec3 {
  return {
    x: m[0]! * p.x + m[4]! * p.y + m[8]! * p.z + m[12]!,
    y: m[1]! * p.x + m[5]! * p.y + m[9]! * p.z + m[13]!,
    z: m[2]! * p.x + m[6]! * p.y + m[10]! * p.z + m[14]!,
  };
}

export function applyToDir(m: Mat4, d: Vec3): Vec3 {
  return {
    x: m[0]! * d.x + m[4]! * d.y + m[8]! * d.z,
    y: m[1]! * d.x + m[5]! * d.y + m[9]! * d.z,
    z: m[2]! * d.x + m[6]! * d.y + m[10]! * d.z,
  };
}

export function determinant(m: Mat4): number {
  const n11 = m[0]!, n12 = m[4]!, n13 = m[8]!, n14 = m[12]!;
  const n21 = m[1]!, n22 = m[5]!, n23 = m[9]!, n24 = m[13]!;
  const n31 = m[2]!, n32 = m[6]!, n33 = m[10]!, n34 = m[14]!;
  const n41 = m[3]!, n42 = m[7]!, n43 = m[11]!, n44 = m[15]!;
  return (
    n41 * (n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34) +
    n42 * (n11 * n23 * n34 - n11 * n24 * n33 + n14 * n21 * n33 - n13 * n21 * n34 + n13 * n24 * n31 - n14 * n23 * n31) +
    n43 * (n11 * n24 * n32 - n11 * n22 * n34 - n14 * n21 * n32 + n12 * n21 * n34 + n14 * n22 * n31 - n12 * n24 * n31) +
    n44 * (-n13 * n22 * n31 - n11 * n23 * n32 + n11 * n22 * n33 + n13 * n21 * n32 - n12 * n21 * n33 + n12 * n23 * n31)
  );
}

/** General 4×4 inverse (three.js algorithm). Throws on a singular matrix. */
export function invert(m: Mat4): Mat4 {
  const n11 = m[0]!, n21 = m[1]!, n31 = m[2]!, n41 = m[3]!;
  const n12 = m[4]!, n22 = m[5]!, n32 = m[6]!, n42 = m[7]!;
  const n13 = m[8]!, n23 = m[9]!, n33 = m[10]!, n43 = m[11]!;
  const n14 = m[12]!, n24 = m[13]!, n34 = m[14]!, n44 = m[15]!;

  const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
  const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
  const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
  const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;

  const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
  if (Math.abs(det) < 1e-300) throw new Error('mat4.invert: singular matrix');
  const d = 1 / det;

  const out: Mat4 = new Array<number>(16);
  out[0] = t11 * d;
  out[1] = (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * d;
  out[2] = (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * d;
  out[3] = (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * d;

  out[4] = t12 * d;
  out[5] = (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * d;
  out[6] = (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * d;
  out[7] = (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * d;

  out[8] = t13 * d;
  out[9] = (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * d;
  out[10] = (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * d;
  out[11] = (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * d;

  out[12] = t14 * d;
  out[13] = (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * d;
  out[14] = (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * d;
  out[15] = (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * d;
  return out;
}

/** three.js Matrix4.decompose: position, unit quaternion [x,y,z,w], scale (scale.x < 0 when det < 0). */
export function decompose(m: Mat4): { position: Vec3; quaternion: Quat; scale: Vec3 } {
  let sx = Math.hypot(m[0]!, m[1]!, m[2]!);
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  if (determinant(m) < 0) sx = -sx;
  const position = { x: m[12]!, y: m[13]!, z: m[14]! };
  const ix = sx === 0 ? 0 : 1 / sx, iy = sy === 0 ? 0 : 1 / sy, iz = sz === 0 ? 0 : 1 / sz;
  const m11 = m[0]! * ix, m21 = m[1]! * ix, m31 = m[2]! * ix;
  const m12 = m[4]! * iy, m22 = m[5]! * iy, m32 = m[6]! * iy;
  const m13 = m[8]! * iz, m23 = m[9]! * iz, m33 = m[10]! * iz;
  const trace = m11 + m22 + m33;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s;
  }
  return { position, quaternion: [x, y, z, w], scale: { x: sx, y: sy, z: sz } };
}

/** three.js Matrix4.compose. */
export function compose(position: Vec3, quaternion: Quat, scale: Vec3 = { x: 1, y: 1, z: 1 }): Mat4 {
  const [x, y, z, w] = quaternion;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = scale.x, sy = scale.y, sz = scale.z;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    position.x, position.y, position.z, 1,
  ];
}

export function equals(a: Mat4, b: Mat4, tol = 1e-9): boolean {
  for (let i = 0; i < 16; i++) if (Math.abs(a[i]! - b[i]!) > tol) return false;
  return true;
}

/** Position part of an affine matrix. */
export function getPosition(m: Mat4): Vec3 { return { x: m[12]!, y: m[13]!, z: m[14]! }; }
