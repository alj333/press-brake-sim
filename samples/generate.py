"""Generate sample sheet-metal parts: STEP solids + DXF flat patterns + truth JSON.

Run: python3 samples/generate.py   (needs cadquery, ezdxf)

Conventions (match ARCHITECTURE.md): mm, k-factor 0.44, BA = rad(theta) * (ri + k*t).
Profile parts are defined by a chain of straight flange lengths (the flat portion of each
flange, excluding bend arcs) and bends (angle from flat, inner radius, direction).
The 3D model is the profile extruded along Z (= the bend line direction) by `width`.
DXF layers follow Fusion 360 / Inventor flat-pattern export: IV_OUTER_PROFILE,
IV_INTERIOR_PROFILES, IV_BEND (up), IV_BEND_DOWN (down).
"""
import json, math, os
import cadquery as cq
import ezdxf

K = 0.44
OUT = os.path.dirname(os.path.abspath(__file__))


def ba(theta, ri, t, k=K):
    return math.radians(theta) * (ri + k * t)


def profile_solid(straights, bends, t, width):
    """Build the 2D section (inner/outer offset curves) and extrude along Z.
    Centreline starts at origin heading +X, sheet mid-surface. 'up' = turn toward +Y (CCW)."""
    # Walk the centreline collecting pieces: ('line', p0, p1) or ('arc', centre, r, a0, a1, ccw)
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
            # centre is to the left (up) of heading for CCW
            cx = x - s * rm * math.sin(heading); cy = y + s * rm * math.cos(heading)
            a0 = math.atan2(y - cy, x - cx)
            a1 = a0 + s * math.radians(theta)
            pieces.append(('arc', (cx, cy), rm, a0, a1, s))
            heading += s * math.radians(theta)
            x = cx + rm * math.cos(a1); y = cy + rm * math.sin(a1)

    def offset_path(d):
        """Offset the centreline by d to the left (+Y side at start). Returns list of segments."""
        out = []
        for pc in pieces:
            if pc[0] == 'line':
                (x0, y0), (x1, y1) = pc[1], pc[2]
                dx, dy = x1 - x0, y1 - y0
                n = math.hypot(dx, dy); nx, ny = -dy / n, dx / n
                out.append(('line', (x0 + nx * d, y0 + ny * d), (x1 + nx * d, y1 + ny * d)))
            else:
                _, (cx, cy), r, a0, a1, s = pc
                rr = r - s * d  # left offset shrinks a CCW arc
                out.append(('arc', (cx, cy), rr, a0, a1, s))
        return out

    left = offset_path(t / 2)
    right = offset_path(-t / 2)

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
        if seg[0] == 'line':
            wp = wp.lineTo(*pt(seg, 1))
        else:
            wp = wp.threePointArc(mid(seg), pt(seg, 1))
    wp = wp.lineTo(*pt(right[-1], 1))
    for seg in reversed(right):
        if seg[0] == 'line':
            wp = wp.lineTo(*pt(seg, 0))
        else:
            wp = wp.threePointArc(mid(seg), pt(seg, 0))
    wp = wp.close()
    return wp.extrude(width)


def profile_flat(straights, bends, t, width, name, holes=()):
    """Flat pattern for a profile part. u along the unfolded chain, v along the width."""
    outline_u = 0.0
    bend_lines = []
    for i, L in enumerate(straights):
        outline_u += L
        if i < len(bends):
            theta, ri, direction = bends[i]
            b = ba(theta, ri, t)
            bend_lines.append({
                'id': f'B{i+1}', 'u': outline_u + b / 2, 'direction': direction,
                'angle': theta, 'innerRadius': ri, 'kFactor': K, 'bendAllowance': b,
            })
            outline_u += b
    flat = {
        'name': name, 'thickness': t, 'width': width, 'length': outline_u,
        'outline': [(0, 0), (outline_u, 0), (outline_u, width), (0, width)],
        'holes': list(holes),
        'bends': [dict(bl, p0=(bl['u'], 0), p1=(bl['u'], width)) for bl in bend_lines],
    }
    return flat


def write_dxf(flat, path):
    doc = ezdxf.new('R2010')
    doc.header['$INSUNITS'] = 4
    for layer in ('IV_OUTER_PROFILE', 'IV_INTERIOR_PROFILES', 'IV_BEND', 'IV_BEND_DOWN', 'IV_ARC_CENTERS'):
        doc.layers.add(layer)
    msp = doc.modelspace()
    msp.add_lwpolyline(flat['outline'], close=True, dxfattribs={'layer': 'IV_OUTER_PROFILE'})
    for h in flat['holes']:
        if h.get('type') == 'circle':
            msp.add_circle(h['center'], h['radius'], dxfattribs={'layer': 'IV_INTERIOR_PROFILES'})
        else:
            msp.add_lwpolyline(h['points'], close=True, dxfattribs={'layer': 'IV_INTERIOR_PROFILES'})
    for b in flat['bends']:
        layer = 'IV_BEND' if b['direction'] == 'up' else 'IV_BEND_DOWN'
        msp.add_line(b['p0'], b['p1'], dxfattribs={'layer': layer})
    doc.saveas(path)


def export(name, solid, flat, truth_extra=None):
    d = os.path.join(OUT, name)
    os.makedirs(d, exist_ok=True)
    cq.exporters.export(solid, os.path.join(d, f'{name}.step'))
    cq.exporters.export(solid, os.path.join(d, f'{name}.stl'), tolerance=0.02, angularTolerance=0.1)
    write_dxf(flat, os.path.join(d, f'{name}-flat.dxf'))
    truth = {'name': name, 'thickness': flat['thickness'], 'kFactor': K,
             'flat': flat, **(truth_extra or {})}
    with open(os.path.join(d, f'{name}.truth.json'), 'w') as f:
        json.dump(truth, f, indent=2)
    bb = solid.val().BoundingBox()
    print(f'{name}: bbox {bb.xlen:.2f} x {bb.ylen:.2f} x {bb.zlen:.2f}, flat {flat["length"]:.3f} x {flat["width"]}')


def main():
    t = 2.0
    # 1. L-bracket: 60 flat + 90° up + 40 flat, width 80, with a Ø10 hole in the base
    straights, bends = [60 - (2 + t), 40 - (2 + t)], [(90, 2.0, 'up')]
    solid = profile_solid(straights, bends, t, 80)
    solid = solid.faces('<Y').workplane().center(25, 40).hole(10)  # hole in first flange (approx)
    flat = profile_flat(straights, bends, t, 80, 'L-bracket',
                        holes=[{'type': 'circle', 'center': (25, 40), 'radius': 5}])
    export('L-bracket', solid, flat, {'bendCount': 1})

    # 2. U-channel: 40 up, 80 web, 40 up (outer dims), width 120
    straights = [40 - (2 + t), 80 - 2 * (2 + t), 40 - (2 + t)]
    bends = [(90, 2.0, 'up'), (90, 2.0, 'up')]
    export('U-channel', profile_solid(straights, bends, t, 120),
           profile_flat(straights, bends, t, 120, 'U-channel'), {'bendCount': 2})

    # 3. Z-bracket: 40 / 50 / 40, one up one down
    straights = [40 - (2 + t), 50 - 2 * (2 + t), 40 - (2 + t)]
    bends = [(90, 2.0, 'up'), (90, 2.0, 'down')]
    export('Z-bracket', profile_solid(straights, bends, t, 100),
           profile_flat(straights, bends, t, 100, 'Z-bracket'), {'bendCount': 2})

    # 4. Hat channel: brim 20, wall 30, top 50, wall 30, brim 20 (outer), bends up,down,down,up
    straights = [20 - (2 + t), 30 - 2 * (2 + t), 50 - 2 * (2 + t), 30 - 2 * (2 + t), 20 - (2 + t)]
    bends = [(90, 2.0, 'up'), (90, 2.0, 'down'), (90, 2.0, 'down'), (90, 2.0, 'up')]
    export('hat-channel', profile_solid(straights, bends, t, 100),
           profile_flat(straights, bends, t, 100, 'hat-channel'), {'bendCount': 4})

    # 5. Acute bracket: 60 flat + 135° (45° included) + 40, t=1.5, ri=1.5
    t2 = 1.5
    straights, bends = [60 - (1.5 + t2), 40 - (1.5 + t2)], [(135, 1.5, 'up')]
    export('acute-bracket', profile_solid(straights, bends, t2, 60),
           profile_flat(straights, bends, t2, 60, 'acute-bracket'), {'bendCount': 1})

    # 6. Box with 4 flanges: outer 200 x 150, flange 30 up, t=2, ri=2, corner reliefs
    ri = 2.0; e = ri + t
    Lx, Lz, h = 200.0, 150.0, 30.0
    def u_solid(web_len, depth):
        u = profile_solid([h - e, web_len - 2 * e, h - e], [(90, ri, 'down'), (90, ri, 'down')], t, depth)
        u = u.rotate((0, 0, 0), (0, 0, 1), 90)   # web along +X, flanges toward +Y
        bb = u.val().BoundingBox()
        return u.translate((-bb.xmin, -bb.ymin, -bb.zmin))
    u1 = u_solid(Lx, Lz - 2 * e).translate((0, 0, e))          # web along X, spans z in [e, Lz-e]
    u2 = u_solid(Lz, Lx - 2 * e).rotate((0, 0, 0), (0, 1, 0), -90)  # web along Z
    bb2 = u2.val().BoundingBox()
    u2 = u2.translate((e - bb2.xmin, -bb2.ymin, -bb2.zmin))     # spans x in [e, Lx-e]
    box = u1.union(u2)
    # flat pattern: cross shape
    b = ba(90, ri, t)
    base_w, base_h = Lx - 2 * e + b, Lz - 2 * e + b       # flat base incl. half zones
    fl = h - e + b / 2                                     # flange flat incl. half zone
    W, H = base_w + 2 * fl, base_h + 2 * fl
    cx, cy = W / 2, H / 2
    hw, hh = base_w / 2, base_h / 2
    outline = [
        (cx - hw, cy - hh - fl), (cx + hw, cy - hh - fl), (cx + hw, cy - hh),
        (cx + hw + fl, cy - hh), (cx + hw + fl, cy + hh), (cx + hw, cy + hh),
        (cx + hw, cy + hh + fl), (cx - hw, cy + hh + fl), (cx - hw, cy + hh),
        (cx - hw - fl, cy + hh), (cx - hw - fl, cy - hh), (cx - hw, cy - hh),
    ]
    zb = b / 2
    bends_flat = [
        {'id': 'B1', 'p0': (cx - hw, cy - hh + zb), 'p1': (cx + hw, cy - hh + zb), 'direction': 'up', 'angle': 90, 'innerRadius': ri, 'kFactor': K, 'bendAllowance': b},
        {'id': 'B2', 'p0': (cx + hw - zb, cy - hh), 'p1': (cx + hw - zb, cy + hh), 'direction': 'up', 'angle': 90, 'innerRadius': ri, 'kFactor': K, 'bendAllowance': b},
        {'id': 'B3', 'p0': (cx - hw, cy + hh - zb), 'p1': (cx + hw, cy + hh - zb), 'direction': 'up', 'angle': 90, 'innerRadius': ri, 'kFactor': K, 'bendAllowance': b},
        {'id': 'B4', 'p0': (cx - hw + zb, cy - hh), 'p1': (cx - hw + zb, cy + hh), 'direction': 'up', 'angle': 90, 'innerRadius': ri, 'kFactor': K, 'bendAllowance': b},
    ]
    flat = {'name': 'box-4-flange', 'thickness': t, 'width': H, 'length': W,
            'outline': outline, 'holes': [], 'bends': bends_flat}
    export('box-4-flange', box, flat, {'bendCount': 4})

    # 7. Custom tool profiles (DXF cross-sections, closed LWPOLYLINE on layer 0)
    tools = os.path.join(OUT, 'tools'); os.makedirs(tools, exist_ok=True)
    doc = ezdxf.new('R2010'); doc.header['$INSUNITS'] = 4
    # Gooseneck-ish punch, tip at origin, +Y up, relief toward -X
    pts = [(0, 0), (6, 6.2), (6, 40), (22, 70), (22, 120), (-12, 120), (-12, 95), (-30, 60), (-30, 45), (-8, 20), (-6, 6.2)]
    doc.modelspace().add_lwpolyline(pts, close=True)
    doc.saveas(os.path.join(tools, 'custom-gooseneck-punch.dxf'))
    doc = ezdxf.new('R2010'); doc.header['$INSUNITS'] = 4
    # V16 88° die, origin at V centre on the top surface
    half = 8.0; depth = half / math.tan(math.radians(44))
    pts = [(-30, 0), (-half, 0), (0, -depth), (half, 0), (30, 0), (30, -60), (-30, -60)]
    doc.modelspace().add_lwpolyline(pts, close=True)
    doc.saveas(os.path.join(tools, 'custom-v16-die.dxf'))
    doc = ezdxf.new('R2010'); doc.header['$INSUNITS'] = 4
    # Backgauge finger: stop face at X=0 from y=0..20, body 60 deep, with a step
    pts = [(0, 0), (0, 20), (25, 20), (25, 35), (60, 35), (60, 0)]
    doc.modelspace().add_lwpolyline(pts, close=True)
    doc.saveas(os.path.join(tools, 'custom-finger.dxf'))
    print('tools written')


if __name__ == '__main__':
    main()
