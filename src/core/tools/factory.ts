/**
 * MotionX factory tooling reconstructed from the Autodesk A360 source supplied in
 * #press-brake-tool. Collision outlines are reconstructed from the public A360 triangle mesh
 * (straight dimensions are reliable; curved edges remain tessellated approximations). Active-die
 * values are the controller records photographed by Boom, so calculation metadata remains aligned
 * with the machine UI even where its nominal V differs from the mesh-derived face lines. Punch
 * calculation metadata follows the physical tip specification confirmed by the factory; the A360
 * mesh remains the conservative collision outline where that source differs.
 */
import type { Die, Polygon2, Punch, Vec2 } from '../types';
import { finishProfile, roundTo } from './profile';

export const MOTIONX_TOOL_SOURCE_URL = 'https://a360.co/4cRLoxM';
export const MOTIONX_TOOL_SOURCE_SHA256 = 'a649126acf35a89fab587132eed03e492cec6385c3f503cddf29ac8cfb0c2039';
export const MOTIONX_PUNCH_ID = 'std:motionx-core-punch-r1';
export const MOTIONX_DIE_PHYSICAL_ID = 'motionx:core-multi-v-die-r1';
export const MOTIONX_DIE_SLOT_IDS = {
  1: 'std:motionx-core-die-r1-slot-1',
  2: 'std:motionx-core-die-r1-slot-2',
  3: 'std:motionx-core-die-r1-slot-3',
  4: 'std:motionx-core-die-r1-slot-4',
  5: 'std:motionx-core-die-r1-slot-5',
  6: 'std:motionx-core-die-r1-slot-6',
  7: 'std:motionx-core-die-r1-slot-7',
} as const;
export const MOTIONX_DEFAULT_DIE_ID = MOTIONX_DIE_SLOT_IDS[1];

/** Confirmed physical tip specification shared by every stocked MotionX punch section. */
export const MOTIONX_PUNCH_SPEC = { tipAngle: 86, tipRadius: 0.2 } as const;

/** Parameters derived from the retained A360 collision outline. */
export const MOTIONX_PUNCH_CAD_SPEC = { tipAngle: 90, tipRadius: 0.2 } as const;

/** Confirmed physical punch inventory: 10 pieces, 2,465 mm total. */
export const MOTIONX_PUNCH_INVENTORY = [
  { length: 10, quantity: 1 },
  { length: 15, quantity: 1 },
  { length: 20, quantity: 1 },
  { length: 50, quantity: 1 },
  { length: 100, quantity: 2 },
  { length: 200, quantity: 1 },
  { length: 300, quantity: 1 },
  { length: 835, quantity: 2 },
] as const;

const DIE_SOURCE_PROFILE: Polygon2 = [
  { x: -22.168629, y: -32.5 }, { x: -9.810216, y: -32.5 }, { x: -9.611022, y: -32.479961 },
  { x: -9.419811, y: -32.420642 }, { x: -9.244249, y: -32.324426 }, { x: -1.760001, y: -27.186499 },
  { x: -1.760001, y: -25.5 }, { x: 0.239999, y: -25.5 }, { x: 0.239999, y: -27.186499 },
  { x: 7.724247, y: -32.324426 }, { x: 7.899814, y: -32.420642 }, { x: 8.091021, y: -32.479961 },
  { x: 8.290215, y: -32.5 }, { x: 14.455786, y: -32.5 }, { x: 14.714603, y: -32.465925 },
  { x: 14.955788, y: -32.366025 }, { x: 15.162892, y: -32.207108 }, { x: 21.999998, y: -25.369999 },
  { x: 21.999998, y: -23.369999 }, { x: 24.000001, y: -23.369999 }, { x: 24.000001, y: -25.369999 },
  { x: 30.837107, y: -32.207108 }, { x: 31.044211, y: -32.366025 }, { x: 31.285396, y: -32.465925 },
  { x: 31.544213, y: -32.5 }, { x: 32.5, y: -32.5 }, { x: 32.5, y: -15.542641 },
  { x: 32.397776, y: -14.766184 }, { x: 32.098074, y: -14.042641 }, { x: 31.621323, y: -13.421321 },
  { x: 17.5, y: 0.699999 }, { x: 15.500002, y: 0.699999 }, { x: 15.500002, y: 2.7 },
  { x: 17.5, y: 2.7 }, { x: 31.621323, y: 16.821322 }, { x: 32.098074, y: 17.442641 },
  { x: 32.397776, y: 18.166184 }, { x: 32.5, y: 18.942642 }, { x: 32.5, y: 32.5 },
  { x: 27.914214, y: 32.5 }, { x: 27.655396, y: 32.465925 }, { x: 27.414212, y: 32.366023 },
  { x: 27.207108, y: 32.207108 }, { x: 18.499999, y: 23.499999 }, { x: 18.499999, y: 21.500001 },
  { x: 16.500001, y: 21.500001 }, { x: 16.500001, y: 23.499999 }, { x: 7.792892, y: 32.207108 },
  { x: 7.585788, y: 32.366023 }, { x: 7.344606, y: 32.465925 }, { x: 7.085786, y: 32.5 },
  { x: -14.085786, y: 32.5 }, { x: -14.344605, y: 32.465925 }, { x: -14.585786, y: 32.366023 },
  { x: -14.792893, y: 32.207108 }, { x: -19.5, y: 27.5 }, { x: -19.5, y: 25.500002 },
  { x: -21.500001, y: 25.500002 }, { x: -21.500001, y: 27.5 }, { x: -26.207106, y: 32.207108 },
  { x: -26.414213, y: 32.366023 }, { x: -26.655395, y: 32.465925 }, { x: -26.914213, y: 32.5 },
  { x: -32.5, y: 32.5 }, { x: -32.5, y: 19.542642 }, { x: -32.397778, y: 18.766184 },
  { x: -32.098076, y: 18.042641 }, { x: -31.62132, y: 17.421322 }, { x: -15.5, y: 1.300001 },
  { x: -13.5, y: 1.300001 }, { x: -13.5, y: -0.699999 }, { x: -15.5, y: -0.699999 },
  { x: -31.62132, y: -16.82132 }, { x: -32.098076, y: -17.442641 }, { x: -32.397778, y: -18.166183 },
  { x: -32.5, y: -18.942641 }, { x: -32.5, y: -32.5 }, { x: -30.83137, y: -32.5 },
  { x: -30.624316, y: -32.472742 }, { x: -30.431371, y: -32.392821 }, { x: -30.265687, y: -32.265685 },
  { x: -27.5, y: -29.5 }, { x: -27.5, y: -27.5 }, { x: -25.5, y: -27.5 },
  { x: -25.5, y: -29.5 }, { x: -22.734313, y: -32.265685 }, { x: -22.568629, y: -32.392821 },
  { x: -22.375684, y: -32.472742 },
];

const PUNCH_SOURCE_PROFILE: Polygon2 = [
  { x: 12.528148, y: -69.164953 }, { x: 12.488947, y: -69.208384 }, { x: 7.723241, y: -73.97378 },
  { x: 7.672615, y: -74.010558 }, { x: 7.613106, y: -74.029894 },
  { x: 7.581820487976074, y: -74.0323543548584 },
  { x: 7.550535, y: -74.029894 }, { x: 7.491026, y: -74.010553 }, { x: 7.4404, y: -73.973775 },
  { x: -12.563276, y: -53.970098 }, { x: -12.563276, y: 47.729902 }, { x: -9.563277, y: 47.729902 },
  { x: -9.563277, y: 56.029902 }, { x: -12.563276, y: 56.029902 }, { x: -12.563276, y: 73.529902 },
  { x: -12.538805, y: 73.684416 }, { x: -12.467785, y: 73.823786 }, { x: -12.357168, y: 73.934412 },
  { x: -12.217784, y: 74.005423 }, { x: -12.063277, y: 74.029894 }, { x: -0.563273, y: 74.029894 },
  { x: -0.408769, y: 74.005423 }, { x: -0.269384, y: 73.934412 }, { x: -0.158768, y: 73.823786 },
  { x: -0.087748, y: 73.684416 }, { x: -0.063276, y: 73.529902 }, { x: -0.063276, y: 44.094305 },
  { x: 12.011118, y: 44.094305 }, { x: 12.165627, y: 44.069834 }, { x: 12.305007, y: 43.998823 },
  { x: 12.415624, y: 43.888197 }, { x: 12.486644, y: 43.748827 }, { x: 12.511115, y: 43.594313 },
  { x: 12.511115, y: 29.094305 }, { x: 0.330663, y: 16.913862 }, { x: 0.251517, y: 16.810846 },
  { x: 0.201578, y: 16.690922 }, { x: 0.184221, y: 16.562176 }, { x: 1.059585, y: -52.633171 },
  { x: 12.270384, y: -63.84397 }, { x: 12.429361, y: -64.051175 }, { x: 12.529263, y: -64.292483 },
  { x: 12.563276, y: -64.55143 }, { x: 12.561684, y: -69.054165 }, { x: 12.553105, y: -69.112039 },
];

const PUNCH_TIP = { x: 7.581820487976074, y: -74.0323543548584 };

function punchProfile(): ReturnType<typeof finishProfile> {
  return finishProfile(PUNCH_SOURCE_PROFILE.map(point => ({
    x: roundTo(point.x - PUNCH_TIP.x, 9),
    y: roundTo(point.y - PUNCH_TIP.y, 9),
  })));
}

type QuarterTurn = 0 | 90 | 180 | -90;

function dieProfile(reference: Vec2, rotation: QuarterTurn): ReturnType<typeof finishProfile> {
  const transform = (point: Vec2): Vec2 => {
    const x = point.x - reference.x;
    const y = point.y - reference.y;
    if (rotation === 90) return { x: -y, y: x };
    if (rotation === 180) return { x: -x, y: -y };
    if (rotation === -90) return { x: y, y: -x };
    return { x, y };
  };
  return finishProfile(DIE_SOURCE_PROFILE.map(point => {
    const transformed = transform(point);
    return { x: roundTo(transformed.x, 6), y: roundTo(transformed.y, 6) };
  }));
}

export function motionXFactoryPunch(): Punch {
  return {
    kind: 'punch',
    id: MOTIONX_PUNCH_ID,
    name: 'MotionX core punch 86° R0.2',
    source: 'standard',
    family: 'gooseneck',
    height: 148.062248355,
    maxLoadPerMeter: 0,
    segmentLengths: MOTIONX_PUNCH_INVENTORY.map(item => item.length),
    segmentInventory: MOTIONX_PUNCH_INVENTORY.map(item => ({ ...item })),
    stockStatus: 'in-stock',
    profile: punchProfile(),
    tipRadius: MOTIONX_PUNCH_SPEC.tipRadius,
    tipAngle: MOTIONX_PUNCH_SPEC.tipAngle,
    bodyWidth: 25.126552,
    tangCentreX: -13.895097,
    notes: `Confirmed physical tip 86° R0.2; A360 mesh-derived profile (${MOTIONX_TOOL_SOURCE_SHA256}) is retained as a conservative approximately 90° collision outline; curved edges are tessellated approximations; load rating awaits factory confirmation.`,
  };
}

export interface MotionXPunchGeometryDiscrepancy {
  confirmed: { tipAngle: number; tipRadius: number };
  cad: { tipAngle: number; tipRadius: number };
}

/** Returns the intentional confirmed-spec↔A360-outline difference for the MotionX punch. */
export function motionXPunchGeometryDiscrepancy(
  punch: Pick<Punch, 'id'>,
): MotionXPunchGeometryDiscrepancy | null {
  if (punch.id !== MOTIONX_PUNCH_ID) return null;
  return {
    confirmed: { ...MOTIONX_PUNCH_SPEC },
    cad: { ...MOTIONX_PUNCH_CAD_SPEC },
  };
}

interface FactoryDieSlot {
  slot: keyof typeof MOTIONX_DIE_SLOT_IDS;
  position: string;
  reference: Vec2;
  rotation: QuarterTurn;
  vWidth: number;
  vAngle: number;
  shoulderRadius: number;
  /** Confirmed controller reference distance from the die edge for stopper calculation (mm). */
  stopperReferenceMm: number;
}

export interface MotionXDieGeometryDiscrepancy {
  slotNumber: string;
  risk: 'review' | 'high';
  controller: { vWidth: number; vAngle: number; shoulderRadius: number };
  cad: { vWidth: number; vAngle: number; shoulderRadius: number };
}

/**
 * Measured groove parameters from the supplied A360 body. These intentionally remain separate
 * from the controller records: controller values drive bend calculations, while the mesh-derived
 * outline drives collision checks.
 */
const MOTIONX_DIE_CAD_PARAMS: Readonly<Record<string, MotionXDieGeometryDiscrepancy['cad']>> = {
  '1': { vWidth: 20, vAngle: 90, shoulderRadius: 1 },
  '2': { vWidth: 17.48, vAngle: 111.06, shoulderRadius: 1 },
  '3': { vWidth: 16.26, vAngle: 90, shoulderRadius: 1 },
  '4': { vWidth: 8, vAngle: 90, shoulderRadius: 0.8 },
  '5': { vWidth: 32, vAngle: 90, shoulderRadius: 3 },
  '6': { vWidth: 36, vAngle: 90, shoulderRadius: 3 },
  '7': { vWidth: 12, vAngle: 90, shoulderRadius: 1 },
};

/** Returns the known controller↔CAD discrepancy only for this physical MotionX multi-V die. */
export function motionXDieGeometryDiscrepancy(
  die: Pick<Die, 'physicalToolId' | 'slotNumber' | 'vWidth' | 'vAngle' | 'shoulderRadius'>,
): MotionXDieGeometryDiscrepancy | null {
  if (die.physicalToolId !== MOTIONX_DIE_PHYSICAL_ID || !die.slotNumber) return null;
  const cad = MOTIONX_DIE_CAD_PARAMS[die.slotNumber];
  if (!cad) return null;
  return {
    slotNumber: die.slotNumber,
    risk: die.slotNumber === '2' || die.slotNumber === '3' ? 'high' : 'review',
    controller: { vWidth: die.vWidth, vAngle: die.vAngle, shoulderRadius: die.shoulderRadius },
    cad: { ...cad },
  };
}

/** Controller records supplied by Boom; positions follow the A360 source view. */
const FACTORY_DIE_SLOTS: readonly FactoryDieSlot[] = [
  { slot: 1, position: 'top-right', reference: { x: 17.5, y: 32.5 }, rotation: 0, vWidth: 16, vAngle: 86, shoulderRadius: 0.5, stopperReferenceMm: 50 },
  { slot: 2, position: 'bottom-centre', reference: { x: -0.760001, y: -32.5 }, rotation: 180, vWidth: 24, vAngle: 86, shoulderRadius: 4, stopperReferenceMm: 33 },
  { slot: 3, position: 'bottom-right', reference: { x: 23, y: -32.5 }, rotation: 180, vWidth: 10, vAngle: 86, shoulderRadius: 0.5, stopperReferenceMm: 52 },
  { slot: 4, position: 'bottom-left', reference: { x: -26.5, y: -32.5 }, rotation: 180, vWidth: 8, vAngle: 86, shoulderRadius: 0.5, stopperReferenceMm: 8 },
  { slot: 5, position: 'right', reference: { x: 32.5, y: 1.7 }, rotation: 90, vWidth: 32, vAngle: 86, shoulderRadius: 4, stopperReferenceMm: 34 },
  { slot: 6, position: 'left', reference: { x: -32.5, y: 0.3 }, rotation: -90, vWidth: 36, vAngle: 86, shoulderRadius: 4, stopperReferenceMm: 33 },
  { slot: 7, position: 'top-left', reference: { x: -20.5, y: 32.5 }, rotation: 0, vWidth: 12, vAngle: 86, shoulderRadius: 2, stopperReferenceMm: 53 },
];

export function motionXFactoryDies(): Die[] {
  return FACTORY_DIE_SLOTS.map(slot => ({
    kind: 'die',
    id: MOTIONX_DIE_SLOT_IDS[slot.slot],
    name: `MotionX multi-V die · V${slot.vWidth}`,
    source: 'standard',
    family: 'multi-v',
    height: 65,
    maxLoadPerMeter: 0,
    segmentLengths: [],
    stockStatus: 'in-stock',
    physicalToolId: MOTIONX_DIE_PHYSICAL_ID,
    slotNumber: String(slot.slot),
    slotPosition: slot.position,
    profile: dieProfile(slot.reference, slot.rotation),
    vWidth: slot.vWidth,
    vAngle: slot.vAngle,
    shoulderRadius: slot.shoulderRadius,
    bodyWidth: 65,
    notes: `Controller die-edge stopper reference ${slot.stopperReferenceMm} mm; A360 mesh-derived body profile (${MOTIONX_TOOL_SOURCE_SHA256}); curved edges are tessellated approximations; die length and load rating await factory confirmation.`,
  }));
}
