"""Generate sample sheet-metal parts: STEP solids + STL + DXF flat patterns + truth JSON.

Run: python3 samples/generate.py   (needs cadquery, ezdxf)

Conventions (match ARCHITECTURE.md): mm, k-factor 0.44, BA = rad(theta) * (ri + k*t).
Profile parts are defined by a chain of straight flange lengths (the flat portion of each
flange, excluding bend arcs) and bends (angle from flat, inner radius, direction).
The 3D model is the profile extruded along the bend-line direction by `width`.
STEP frame is RIGHT-HANDED w.r.t. the flat: (u, v, w) -> (X, -Z, Y) (then shifted so z >= 0),
i.e. related to the PART frame of types.ts by a rigid motion only.
DXF layers follow Fusion 360 / Inventor flat-pattern export: IV_OUTER_PROFILE,
IV_INTERIOR_PROFILES, IV_BEND (up), IV_BEND_DOWN (down).
truth.json: { name, thickness, kFactor, flat: FlatPattern (types.ts shape), expected: {...} }
"""
import json, math, os
import cadquery as cq
import ezdxf

K = 0.44
OUT = os.path.dirname(os.path.abspath(__file__))
MATERIAL = {'id': 'std:mild-steel', 'Rm': 420.0, 'k': K, 'sb': 1.5, 'minR': 0.8}


def ba(theta, ri, t, k=K):
    return math.radians(theta) * (ri + k * t)


# ─────────────────────────────────────────────────────────────────────────────
# Solid builders
# ─────────────────────────────────────────────────────────────────────────────

def profile_solid(straights, bends, t, width):
    """Build the 2D section (inner/outer offset curves) in XY and extrude along +Z by width.
    Centreline starts at origin heading +X on the sheet mid-surface. 'up' = turn toward +Y (CCW).
    Sheet normal w = +Y at the start; u = +X; v (bend line direction) = +Z (mirrored later)."""
    pieces = []
    x, y, heading = 0.0, 0.0, 0.0
    for i, L in enumerate(straights):
        p0 = (x, y)
        x += L * math.cos(heading); y += L * math.sin(heading)
        pieces.append(('line', p0, (x, y)))
        if i < len(bends):
            theta, ri, direction = bends[i]
            rm = ri + t / 2
            s = 1 if direction == 'up' else -1
            cx = x - s * rm * math.sin(heading); cy = y + s * rm * math.cos(heading)
            a0 = math.atan2(y - cy, x - cx)
            a1 = a0 + s * math.radians(theta)
            pieces.append(('arc', (cx, cy), rm, a0, a1, s))
            heading += s * math.radians(theta)
            x = cx + rm * math.cos(a1); y = cy + rm * math.sin(a1)

    def offset_path(d):
        out = []
        for pc in pieces:
            if pc[0] == 'line':
                (x0, y0), (x1, y1) = pc[1], pc[2]
                dx, dy = x1 - x0, y1 - y0
                n = math.hypot(dx, dy); nx, ny = -dy / n, dx / n
                out.append(('line', (x0 + nx * d, y0 + ny * d), (x1 + nx * d, y1 + ny * d)))
            else:
                _, (cx, cy), r, a0, a1, s = pc
                out.append(('arc', (cx, cy), r - s * d, a0, a1, s))
        return out

    left, right = offset_path(t / 2), offset_path(-t / 2)

    def pt(seg, end):
        if seg[0] == 'line':
            return seg[1] if end == 0 else seg[2]
        _, (cx, cy), r, a0, a1, s = seg
        a = a0 if end == 0 else a1
        return (cx + r * math.cos(a), cy + r * math.sin(a))

    def mid(seg):
        _, (cx, cy), r, a0, a1, s = seg
        a = (a0 + a1) / 2
        return (cx + r * math.cos(a), cy + r * math.sin(a))

    wp = cq.Workplane('XY').moveTo(*pt(left[0], 0))
    for seg in left:
        wp = wp.lineTo(*pt(seg, 1)) if seg[0] == 'line' else wp.threePointArc(mid(seg), pt(seg, 1))
    wp = wp.lineTo(*pt(right[-1], 1))
    for seg in reversed(right):
        wp = wp.lineTo(*pt(seg, 0)) if seg[0] == 'line' else wp.threePointArc(mid(seg), pt(seg, 0))
    return wp.close().extrude(width)


def right_handed(solid):
    """Mirror Z so (u, v, w) -> (X, -Z, Y) is a proper rotation of the flat, then shift z >= 0."""
    s = solid.mirror('XY')
    bb = s.val().BoundingBox()
    return s.translate((0, 0, -bb.zmin))


# ─────────────────────────────────────────────────────────────────────────────
# Flat pattern builders (types.ts FlatPattern shape)
# ─────────────────────────────────────────────────────────────────────────────

def P(x, y):
    return {'x': round(x, 6), 'y': round(y, 6)}


def bend_line(bid, p0, p1, direction, theta, ri, src='dxf'):
    return {
        'id': bid, 'p0': P(*p0), 'p1': P(*p1), 'direction': direction, 'angle': theta,
        'innerRadius': ri, 'kFactor': K,
        'sources': {'geometry': src, 'angle': src, 'radius': src, 'direction': src},
    }


def circle_hole(cx, cy, r, n=72):
    # CW winding for holes
    return [P(cx + r * math.cos(-2 * math.pi * i / n), cy + r * math.sin(-2 * math.pi * i / n)) for i in range(n)]


def profile_flat(straights, bends, t, width, name, holes=()):
    """Flat pattern for a profile part. u along the unfolded chain, v along the width."""
    u = 0.0
    lines = []
    for i, L in enumerate(straights):
        u += L
        if i < len(bends):
            theta, ri, direction = bends[i]
            b = ba(theta, ri, t)
            uc = u + b / 2
            lines.append(bend_line(f'B{i+1}', (uc, 0), (uc, width), direction, theta, ri))
            u += b
    return {
        'id': name, 'name': name, 'thickness': t, 'materialId': MATERIAL['id'],
        'outline': [P(0, 0), P(u, 0), P(u, width), P(0, width)],
        'holes': [circle_hole(*h) for h in holes],
        'bends': lines, 'sourceUnits': 'mm',
    }


# ─────────────────────────────────────────────────────────────────────────────
# Expected values (closed form from ARCHITECTURE.md)
# ─────────────────────────────────────────────────────────────────────────────

def goldens(flat, t, punch_tip_r=0.8, v=None, rs=None):
    """Per-bend goldens for the default test setup (straight 88° R0.8 punch, 88° V die)."""
    V = v or (8 * t if t <= 3 else 10 * t if t <= 6 else 12 * t)
    V = float(V)
    rs = rs if rs is not None else round(V / 10 * 2) / 2
    Rm, k, sb0, minR = MATERIAL['Rm'], MATERIAL['k'], MATERIAL['sb'], MATERIAL['minR']
    per = {}
    for b in flat['bends']:
        theta = b['angle']
        ri_act = max(0.16 * V * Rm / 420, punch_tip_r, minR * t)
        sb = min(max(sb0 * (0.5 + 0.5 * ri_act / t) * (theta / 90), 0.3), 12)
        over = theta + sb
        thi = 180 - over
        D = (V / 2) / math.tan(math.radians(thi / 2)) + ri_act - (ri_act + t) / math.sin(math.radians(thi / 2))
        L = math.dist((b['p0']['x'], b['p0']['y']), (b['p1']['x'], b['p1']['y']))
        fpm = 1.42 * Rm * t * t / V
        ossb = math.tan(math.radians(theta / 2)) * (b['innerRadius'] + t) if theta <= 90 else b['innerRadius'] + t
        per[b['id']] = {
            'bendAllowance': ba(theta, b['innerRadius'], t),
            'bendDeduction': 2 * ossb - ba(theta, b['innerRadius'], t),
            'includedAngle': 180 - theta, 'actualInnerRadius': ri_act, 'springback': sb,
            'overbendAngle': over, 'loadedIncludedAngle': thi, 'ramDepthSharpShoulder': max(D, -t),
            'bendLength': L, 'forcePerMeter': fpm, 'force': fpm * L / 1000,
            'minLegOutside': (V / 2) / math.sin(math.radians(thi / 2)) + rs + 2,
        }
    return {'defaultSetup': {'punch': 'std:punch-straight-88-r0.8', 'die': f'std:die-v{int(V)}-88',
                             'dieV': V, 'dieAngle': 88, 'shoulderRadius': rs, 'punchTipRadius': punch_tip_r},
            'perBend': per,
            'tolerances': {'length': 0.05, 'angle': 0.5, 'forcePercent': 2, 'ramDepth': 0.3}}


# ─────────────────────────────────────────────────────────────────────────────
# Writers
# ─────────────────────────────────────────────────────────────────────────────

def write_dxf(flat, path):
    doc = ezdxf.new('R2010')
    doc.header['$INSUNITS'] = 4
    for layer in ('IV_OUTER_PROFILE', 'IV_INTERIOR_PROFILES', 'IV_BEND', 'IV_BEND_DOWN', 'IV_ARC_CENTERS'):
        doc.layers.add(layer)
    msp = doc.modelspace()
    msp.add_lwpolyline([(p['x'], p['y']) for p in flat['outline']], close=True,
                       dxfattribs={'layer': 'IV_OUTER_PROFILE'})
    for h in flat['holes']:
        if h.get('circle'):
            msp.add_circle(h['circle']['c'], h['circle']['r'], dxfattribs={'layer': 'IV_INTERIOR_PROFILES'})
        else:
            msp.add_lwpolyline([(p['x'], p['y']) for p in h], close=True,
                               dxfattribs={'layer': 'IV_INTERIOR_PROFILES'})
    for b in flat['bends']:
        layer = 'IV_BEND' if b['direction'] == 'up' else 'IV_BEND_DOWN'
        msp.add_line((b['p0']['x'], b['p0']['y']), (b['p1']['x'], b['p1']['y']), dxfattribs={'layer': layer})
    doc.saveas(path)


def export(name, solid, flat, expected_extra, circles=()):
    d = os.path.join(OUT, name)
    os.makedirs(d, exist_ok=True)
    solid = right_handed(solid)
    cq.exporters.export(solid, os.path.join(d, f'{name}.step'))
    cq.exporters.export(solid, os.path.join(d, f'{name}.stl'), tolerance=0.02, angularTolerance=0.1)
    # DXF gets true circles for holes (importer must flatten them); truth gets flattened polygons
    flat_dxf = dict(flat, holes=[{'circle': {'c': (c[0], c[1]), 'r': c[2]}} for c in circles])
    write_dxf(flat_dxf, os.path.join(d, f'{name}-flat.dxf'))
    bb = solid.val().BoundingBox()
    t = flat['thickness']
    expected = {
        'bendCount': len(flat['bends']),
        'directions': {b['id']: b['direction'] for b in flat['bends']},
        'bendAllowance': {b['id']: ba(b['angle'], b['innerRadius'], t) for b in flat['bends']},
        'foldedBounds': {'x': round(bb.xlen, 3), 'y': round(bb.ylen, 3), 'z': round(bb.zlen, 3)},
        'flatBounds': {
            'w': max(p['x'] for p in flat['outline']) - min(p['x'] for p in flat['outline']),
            'h': max(p['y'] for p in flat['outline']) - min(p['y'] for p in flat['outline']),
        },
        'frame': {'u': 'X', 'v': '-Z', 'w': 'Y', 'handedness': 'right'},
        'holeCount': len(flat['holes']),
        **goldens(flat, t, v=expected_extra.pop('dieV', None)),
        **expected_extra,
    }
    truth = {'name': name, 'thickness': t, 'kFactor': K, 'material': MATERIAL, 'flat': flat, 'expected': expected}
    with open(os.path.join(d, f'{name}.truth.json'), 'w') as f:
        json.dump(truth, f, indent=1)
    print(f'{name}: bbox {bb.xlen:.2f} x {bb.ylen:.2f} x {bb.zlen:.2f}, '
          f'flat {expected["flatBounds"]["w"]:.3f} x {expected["flatBounds"]["h"]:.3f}, bends {len(flat["bends"])}')


def cylinder_cut(solid, x, z, r, t):
    cyl = cq.Workplane('XY').add(cq.Solid.makeCylinder(r, t + 10, cq.Vector(x, -5, z), cq.Vector(0, 1, 0)))
    return solid.cut(cyl)


# ─────────────────────────────────────────────────────────────────────────────
# Parts
# ─────────────────────────────────────────────────────────────────────────────

def main():
    t = 2.0; ri = 2.0; e = ri + t

    # 1. L-bracket: outer 60 + 90° up + 40, width 80, Ø10 hole in the base at (25, 40)
    straights, bends = [60 - e, 40 - e], [(90, ri, 'up')]
    solid = cylinder_cut(profile_solid(straights, bends, t, 80), 25, 40, 5, t)
    flat = profile_flat(straights, bends, t, 80, 'L-bracket', holes=[(25, 40, 5)])
    export('L-bracket', solid, flat, {'flangeCount': 2, 'rootFlangeIsLongest': True}, circles=[(25, 40, 5)])

    # 2. U-channel: 40 up, 80 web, 40 up (outer dims), width 120
    straights, bends = [40 - e, 80 - 2 * e, 40 - e], [(90, ri, 'up'), (90, ri, 'up')]
    export('U-channel', profile_solid(straights, bends, t, 120),
           profile_flat(straights, bends, t, 120, 'U-channel'), {'flangeCount': 3, 'expectedFlips': 0})

    # 3. Z-bracket: 40 / 50 / 40, one up one down
    straights, bends = [40 - e, 50 - 2 * e, 40 - e], [(90, ri, 'up'), (90, ri, 'down')]
    export('Z-bracket', profile_solid(straights, bends, t, 100),
           profile_flat(straights, bends, t, 100, 'Z-bracket'), {'flangeCount': 3, 'expectedFlips': 1})

    # 4. Hat channel: brim 20, wall 30, top 50, wall 30, brim 20 (outer), bends up,down,down,up
    straights = [20 - e, 30 - 2 * e, 50 - 2 * e, 30 - 2 * e, 20 - e]
    bends = [(90, ri, 'up'), (90, ri, 'down'), (90, ri, 'down'), (90, ri, 'up')]
    export('hat-channel', profile_solid(straights, bends, t, 100),
           profile_flat(straights, bends, t, 100, 'hat-channel'), {'flangeCount': 5, 'maxFlips': 2})

    # 5. Acute bracket: 60 + 135° (45° included) + 40, t=1.5, ri=1.5 (needs 30° tooling)
    t2 = 1.5; e2 = 1.5 + t2
    straights, bends = [60 - e2, 40 - e2], [(135, 1.5, 'up')]
    export('acute-bracket', profile_solid(straights, bends, t2, 60),
           profile_flat(straights, bends, t2, 60, 'acute-bracket'),
           {'flangeCount': 2, 'needsAcuteTooling': True, 'dieV': 12})

    # 6. Box with 4 flanges: outer 200 x 150, flange 30 up, corner reliefs. Flat frame: u = X, v = -Z.
    Lx, Lz, h = 200.0, 150.0, 30.0
    b = ba(90, ri, t)

    def u_solid(web_len, depth):
        u = profile_solid([h - e, web_len - 2 * e, h - e], [(90, ri, 'down'), (90, ri, 'down')], t, depth)
        u = u.rotate((0, 0, 0), (0, 0, 1), 90)   # web along +X, flanges toward +Y
        bb = u.val().BoundingBox()
        return u.translate((-bb.xmin, -bb.ymin, -bb.zmin))
    u1 = u_solid(Lx, Lz - 2 * e).translate((0, 0, e))              # web along X, z in [e, Lz-e]
    u2 = u_solid(Lz, Lx - 2 * e).rotate((0, 0, 0), (0, 1, 0), -90)  # web along Z
    bb2 = u2.val().BoundingBox()
    u2 = u2.translate((e - bb2.xmin, -bb2.ymin, -bb2.zmin))         # x in [e, Lx-e]
    box = u1.union(u2)
    # Flat: base flat rectangle (Lx-2e) x (Lz-2e) + zones (b each side) ; flanges (h-e) + b/2... as tabs
    base_w, base_h = Lx - 2 * e, Lz - 2 * e                       # flat base between zones
    tab_len = (h - e) + b                                           # zone + flange flat
    tab_w_x, tab_w_z = Lx - 2 * e, Lz - 2 * e                       # STEP wall lengths 192 / 142
    # keep tabs spanning exactly the wall length; the base rectangle is base_w x base_h, corners notched
    cx, cy = tab_len + base_w / 2, tab_len + base_h / 2
    hw, hh = base_w / 2, base_h / 2
    outline = [
        P(cx - hw, cy - hh - tab_len), P(cx + hw, cy - hh - tab_len), P(cx + hw, cy - hh),
        P(cx + hw + tab_len, cy - hh), P(cx + hw + tab_len, cy + hh), P(cx + hw, cy + hh),
        P(cx + hw, cy + hh + tab_len), P(cx - hw, cy + hh + tab_len), P(cx - hw, cy + hh),
        P(cx - hw - tab_len, cy + hh), P(cx - hw - tab_len, cy - hh), P(cx - hw, cy - hh),
    ]
    zb = b / 2  # bend line = zone centre, zone starts at the base rectangle edge
    lines = [
        bend_line('B1', (cx - hw, cy - hh - zb), (cx + hw, cy - hh - zb), 'up', 90, ri),
        bend_line('B2', (cx + hw + zb, cy - hh), (cx + hw + zb, cy + hh), 'up', 90, ri),
        bend_line('B3', (cx - hw, cy + hh + zb), (cx + hw, cy + hh + zb), 'up', 90, ri),
        bend_line('B4', (cx - hw - zb, cy - hh), (cx - hw - zb, cy + hh), 'up', 90, ri),
    ]
    flat = {'id': 'box-4-flange', 'name': 'box-4-flange', 'thickness': t, 'materialId': MATERIAL['id'],
            'outline': outline, 'holes': [], 'bends': lines, 'sourceUnits': 'mm'}
    export('box-4-flange', box, flat, {'flangeCount': 5, 'expectedFlips': 0, 'wallLengths': [tab_w_x, tab_w_z],
                                        'note': 'bends 3/4 need a punch shorter than the clear width between standing walls'})

    # 7. Tabbed plate: 120 x 80 plate, 30-wide tab bent up 90° at the u=120 edge with 2 mm relief
    #    slots, bend line 2 mm inside the plate edge; Ø8 hole 8 mm from the u=0 (gauged) edge at v=60.
    tab_w, slot_w, tab_out = 30.0, 2.0, 25.0
    v0, v1 = 25.0, 55.0
    bl_u = 120.0 - 2.0                         # bend line u
    zone0 = bl_u - b / 2                       # zone start (parent side)
    zone1 = bl_u + b / 2
    zs = zone0 - 1.0                           # slot start
    tab_end = zone1 + (tab_out - e)
    outline = [P(0, 0), P(120, 0), P(120, v0 - slot_w), P(zs, v0 - slot_w), P(zs, v0),
               P(tab_end, v0), P(tab_end, v1), P(zs, v1), P(zs, v1 + slot_w), P(120, v1 + slot_w),
               P(120, 80), P(0, 80)]
    flat = {'id': 'tabbed-plate', 'name': 'tabbed-plate', 'thickness': t, 'materialId': MATERIAL['id'],
            'outline': outline, 'holes': [circle_hole(12, 60, 4)],
            'bends': [bend_line('B1', (bl_u, v0), (bl_u, v1), 'up', 90, ri)], 'sourceUnits': 'mm'}
    plate = cq.Workplane('XY').box(120, t, 80, centered=False)             # x 0..120, y 0..t, z 0..80
    for (za, zb_) in ((v0 - slot_w, v0), (v1, v1 + slot_w)):
        plate = plate.cut(cq.Workplane('XY').box(120 - zs + 1, t + 2, zb_ - za, centered=False)
                          .translate((zs, -1, za)))
    plate = plate.cut(cq.Workplane('XY').box(120 - zone0 + 1, t + 2, v1 - v0, centered=False)
                      .translate((zone0, -1, v0)))
    tab = profile_solid([zone0, tab_out - e], [(90, ri, 'up')], t, tab_w).translate((0, t / 2, v0))
    solid = cylinder_cut(plate.union(tab), 12, 60, 4, t)
    export('tabbed-plate', solid, flat, {'flangeCount': 2, 'shortBendLine': True,
                                          'holeNearGaugedEdge': {'u': 12, 'v': 60, 'r': 4}}, circles=[(12, 60, 4)])

    # 8. Custom tool profiles (DXF cross-sections, closed LWPOLYLINE on layer 0)
    tools = os.path.join(OUT, 'tools'); os.makedirs(tools, exist_ok=True)

    def tool_dxf(name, pts):
        doc = ezdxf.new('R2010'); doc.header['$INSUNITS'] = 4
        doc.modelspace().add_lwpolyline(pts, close=True)
        doc.saveas(os.path.join(tools, name))
    # Gooseneck punch: tip at origin, +Y up, short nose, relief cut back above it toward -X, load-bearing back (+X)
    tool_dxf('custom-gooseneck-punch.dxf',
             [(0, 0), (6, 6.2), (6, 25), (26, 55), (26, 120), (-12, 120), (-12, 92), (4, 70), (6, 45), (-7, 28), (-6, 6.2)])
    half = 8.0; depth = half / math.tan(math.radians(44))
    tool_dxf('custom-v16-die.dxf', [(-30, 0), (-half, 0), (0, -depth), (half, 0), (30, 0), (30, -60), (-30, -60)])
    tool_dxf('custom-finger.dxf', [(0, 0), (0, 20), (25, 20), (25, 35), (60, 35), (60, 0)])
    print('tools written')


if __name__ == '__main__':
    main()
