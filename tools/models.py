"""Build the three hero vehicles (orbiter, rotorcraft, lander) as GLB files.

Run with Blender 4.5:

    blender -b --factory-startup -P models.py -- --out <dir>
        [--only orbiter|rotorcraft|lander] [--preview <dir>] [--raw <dir>]

Every mesh is generated here. The script exports one uncompressed GLB per
vehicle, then runs gltfpack 0.25.0 (through npx) to write <out>/<name>.glb.
With --preview it also renders PNG views of each vehicle with Cycles.
With --raw the uncompressed exports are kept in that folder.

Conventions
    Units are metres. Blender Z is up and the vehicles face Blender -Y.
    The exporter converts to Y up, so in three.js up is +Y, forward is +Z
    and the vehicle's left side is +X.
    Each named node is a root object with identity rotation and scale. Its
    translation is the pivot listed in ORIGINS below.
    Ambient occlusion is baked per vertex into COLOR_0.
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from math import cos, pi, radians, sin, sqrt

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector, noise

# ---------------------------------------------------------------------------
# Materials. Principled BSDF only, no textures.
# ---------------------------------------------------------------------------

MAT_SPECS = {
    # machined and anodised metal
    "alu": dict(color=(0.74, 0.75, 0.77), metallic=1.0, rough=0.34),
    "alu_dark": dict(color=(0.10, 0.105, 0.12), metallic=0.85, rough=0.46),
    "deck": dict(color=(0.20, 0.21, 0.22), metallic=0.6, rough=0.62),
    # composites and coatings
    "carbon": dict(color=(0.020, 0.022, 0.026), metallic=0.1, rough=0.46),
    "white_paint": dict(color=(0.86, 0.86, 0.84), metallic=0.0, rough=0.55),
    "black_matte": dict(color=(0.012, 0.012, 0.014), metallic=0.0, rough=0.9),
    "cable": dict(color=(0.05, 0.045, 0.04), metallic=0.0, rough=0.6),
    "pad": dict(color=(0.07, 0.07, 0.075), metallic=0.0, rough=0.8),
    # multilayer insulation
    "mli_gold": dict(color=(0.86, 0.60, 0.22), metallic=1.0, rough=0.30),
    "mli_silver": dict(color=(0.74, 0.75, 0.78), metallic=1.0, rough=0.36),
    "mli_black": dict(color=(0.035, 0.035, 0.04), metallic=0.7, rough=0.42),
    # optics, cells, radiators, engines
    "glass": dict(color=(0.010, 0.012, 0.020), metallic=0.3, rough=0.06),
    "mirror": dict(color=(0.03, 0.035, 0.05), metallic=1.0, rough=0.08),
    "solar_cell": dict(color=(0.015, 0.035, 0.13), metallic=0.85, rough=0.22),
    "solar_back": dict(color=(0.05, 0.048, 0.045), metallic=0.2, rough=0.55),
    "radiator": dict(color=(0.90, 0.91, 0.93), metallic=0.35, rough=0.22),
    "nozzle": dict(color=(0.20, 0.16, 0.13), metallic=1.0, rough=0.42),
    "leading_edge": dict(color=(0.62, 0.62, 0.64), metallic=1.0, rough=0.28),
    # materials the engine addresses by name
    "rotor_blur": dict(color=(0.04, 0.04, 0.045), metallic=0.0, rough=0.6,
                       alpha=0.3, double=True),
    "lamp": dict(color=(1.0, 1.0, 1.0), metallic=0.0, rough=0.2,
                 emission=(1.0, 0.95, 0.86), estr=6.0),
    "beacon": dict(color=(1.0, 0.6, 0.2), metallic=0.0, rough=0.3,
                   emission=(1.0, 0.55, 0.16), estr=5.0),
}


def M(name):
    """Return the material with this name, creating it on first use."""
    m = bpy.data.materials.get(name)
    if m:
        return m
    s = MAT_SPECS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*s["color"], 1.0)
    b.inputs["Metallic"].default_value = s["metallic"]
    b.inputs["Roughness"].default_value = s["rough"]
    if "emission" in s:
        b.inputs["Emission Color"].default_value = (*s["emission"], 1.0)
        b.inputs["Emission Strength"].default_value = s["estr"]
    if s.get("alpha", 1.0) < 1.0:
        b.inputs["Alpha"].default_value = s["alpha"]
        m.surface_render_method = "BLENDED"
    m.use_backface_culling = not s.get("double", False)
    return m


# ---------------------------------------------------------------------------
# Part collection. Primitives are added to the current group inside the
# current frame, then finish() joins each group into one named object.
# ---------------------------------------------------------------------------

STACK = [Matrix.Identity(4)]
GROUPS = {}
CUR = ["body"]

# Rotations that turn a panel built in the XY plane (normal +Z) to face
# a box side. The comments give where local x and y end up.
FACE = {
    "+x": (0, 90, 0),    # x to -Z, y to +Y
    "-x": (0, -90, 0),   # x to +Z, y to +Y
    "-y": (90, 0, 0),    # x to +X, y to +Z
    "+y": (-90, 0, 0),   # x to +X, y to -Z
    "+z": (0, 0, 0),     # x to +X, y to +Y
    "-z": (180, 0, 0),   # x to +X, y to -Y
}
NORMAL = {"+x": (1, 0, 0), "-x": (-1, 0, 0), "+y": (0, 1, 0),
          "-y": (0, -1, 0), "+z": (0, 0, 1), "-z": (0, 0, -1)}


def TR(loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    """Matrix from a location, XYZ Euler angles in degrees, and a scale."""
    m = Matrix.Translation(loc) @ Euler(
        [radians(a) for a in rot], "XYZ").to_matrix().to_4x4()
    if tuple(scale) != (1, 1, 1):
        m = m @ Matrix.Diagonal((*scale, 1.0))
    return m


class frame:
    """Context manager that pushes a local coordinate frame."""

    def __init__(self, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
        self.m = TR(loc, rot, scale)

    def __enter__(self):
        STACK.append(STACK[-1] @ self.m)

    def __exit__(self, *exc):
        STACK.pop()


def face(axis, dist):
    """Frame on a box side: origin on the side, local +Z pointing outward."""
    return frame(loc=tuple(dist * c for c in NORMAL[axis]), rot=FACE[axis])


def use(name):
    CUR[0] = name
    GROUPS.setdefault(name, [])


def add(bm, mat, loc=(0, 0, 0), rot=(0, 0, 0), bevel=0.0, segs=2,
        smooth=True, sharp=40.0, matrix=None):
    """Turn a bmesh into a part object in the current group and frame.

    Bevelled parts are fully smooth and rely on the bevel plus weighted
    normals. Parts without a bevel get sharp edges above the angle limit.
    """
    mats = [mat] if isinstance(mat, str) else list(mat)
    bm.normal_update()
    for f in bm.faces:
        f.smooth = smooth
    if smooth and not bevel:
        lim = radians(sharp)
        for e in bm.edges:
            if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > lim:
                e.smooth = False
    me = bpy.data.meshes.new("part")
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(M(m))
    ob = bpy.data.objects.new("part", me)
    bpy.context.scene.collection.objects.link(ob)
    ob.matrix_world = STACK[-1] @ (matrix if matrix is not None
                                   else TR(loc, rot))
    if bevel:
        mod = ob.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = segs
        mod.limit_method = "ANGLE"
        mod.angle_limit = radians(40)
    GROUPS[CUR[0]].append(ob)


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------

def box(size, loc=(0, 0, 0), rot=(0, 0, 0), mat="alu", bevel=0.0, segs=2):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=size, verts=bm.verts)
    add(bm, mat, loc, rot, bevel, segs)


def cyl(r, h, loc=(0, 0, 0), rot=(0, 0, 0), mat="alu", n=24, bevel=0.0,
        segs=2, r2=None):
    """Cylinder or cone along local Z, centred. r is the radius at -Z."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=n,
                          radius1=r, radius2=r if r2 is None else r2, depth=h)
    add(bm, mat, loc, rot, bevel, segs)


def rod(p0, p1, r, mat="alu", n=8, r2=None, bevel=0.0):
    """Cylinder between two points of the current frame."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=n,
                          radius1=r, radius2=r if r2 is None else r2,
                          depth=d.length)
    q = Vector((0, 0, 1)).rotation_difference(d.normalized())
    mat4 = Matrix.Translation((p0 + p1) / 2) @ q.to_matrix().to_4x4()
    add(bm, mat, bevel=bevel, segs=1, matrix=mat4)


def _crinkle(p):
    """Foil wrinkle height in the range -1 to 1 at a noise coordinate."""
    a = max(-1.0, min(1.0, 2.4 * noise.noise(p)))
    q = noise.noise(p * 2.1 + Vector((11.0, 3.0, 5.0)))
    b = 1.0 - 2.0 * min(1.0, 3.0 * abs(q))
    return 0.5 * a + 0.5 * b


def lathe(profile, mat, n=24, loc=(0, 0, 0), rot=(0, 0, 0), closed=True,
          flip=False, bevel=0.0, segs=2, seg_mats=None, crinkle=0.0,
          cfreq=4.0, seed=0.0, smooth=True, sharp=40.0):
    """Revolve a list of (radius, z) points about local Z.

    A profile that climbs on the outside gives outward normals. Closed
    profiles get their normals recalculated. seg_mats gives a material
    slot per profile segment. crinkle displaces the radius with noise.
    """
    bm = bmesh.new()
    m = len(profile)
    rings = []
    for j, (r, z) in enumerate(profile):
        if r < 1e-7:
            rings.append([bm.verts.new((0, 0, z))])
            continue
        ring = []
        for i in range(n):
            a = 2 * pi * i / n
            rr = r
            if crinkle and 0 < j < m - 1:
                rr += crinkle * _crinkle(Vector(
                    (2.2 * cos(a), 2.2 * sin(a), z * cfreq + seed)))
            ring.append(bm.verts.new((rr * cos(a), rr * sin(a), z)))
        rings.append(ring)
    for j in range(m if closed else m - 1):
        a, b = rings[j], rings[(j + 1) % m]
        if len(a) == 1 and len(b) == 1:
            continue
        for i in range(n):
            i2 = (i + 1) % n
            if len(a) == 1:
                f = bm.faces.new((a[0], b[i2], b[i]))
            elif len(b) == 1:
                f = bm.faces.new((a[i], a[i2], b[0]))
            else:
                f = bm.faces.new((a[i], a[i2], b[i2], b[i]))
            if seg_mats:
                f.material_index = seg_mats[j]
    if closed:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if flip:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    add(bm, mat, loc, rot, bevel, segs, smooth=smooth, sharp=sharp)


def tube(r_out, r_in, h, loc=(0, 0, 0), rot=(0, 0, 0), mat="alu", n=24,
         bevel=0.0, segs=2):
    """Ring with a rectangular section, centred on local Z."""
    lathe([(r_out, -h / 2), (r_out, h / 2), (r_in, h / 2), (r_in, -h / 2)],
          mat, n, loc, rot, bevel=bevel, segs=segs)


def shell(profile, th, mat_out, mat_in, n=24, loc=(0, 0, 0), rot=(0, 0, 0)):
    """Revolved thin wall. mat_out is on the right of the profile direction
    (the outside of a profile that climbs), mat_in on the other side."""
    m = len(profile)
    inner = []
    for j, (r, z) in enumerate(profile):
        a = profile[max(j - 1, 0)]
        b = profile[min(j + 1, m - 1)]
        d = Vector((b[0] - a[0], b[1] - a[1])).normalized()
        nr, nz = d.y, -d.x
        ri = r - th * nr if r > 1e-7 else 0.0
        inner.append((max(ri, 0.0), z - th * nz))
    loop = list(profile) + inner[::-1]
    seg = [0] * (m - 1) + [0] + [1] * (m - 1) + [0]
    lathe(loop, [mat_out, mat_in], n, loc, rot, seg_mats=seg)


def sweep(pts, r, mat="cable", n=6):
    """Tube along a polyline in the current frame."""
    P = [Vector(p) for p in pts]
    tans = []
    for i in range(len(P)):
        if i == 0:
            t = P[1] - P[0]
        elif i == len(P) - 1:
            t = P[-1] - P[-2]
        else:
            t = (P[i + 1] - P[i]).normalized() + (P[i] - P[i - 1]).normalized()
        tans.append(t.normalized())
    bm = bmesh.new()
    up = tans[0].orthogonal().normalized()
    rings = []
    for i, t in enumerate(tans):
        if i > 0:
            up = tans[i - 1].rotation_difference(t) @ up
        side = t.cross(up).normalized()
        up = side.cross(t).normalized()
        rings.append([bm.verts.new(P[i] + r * (cos(2 * pi * k / n) * up
                                               + sin(2 * pi * k / n) * side))
                      for k in range(n)])
    for a, b in zip(rings[:-1], rings[1:]):
        for k in range(n):
            k2 = (k + 1) % n
            bm.faces.new((a[k], a[k2], b[k2], b[k]))
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    add(bm, mat, sharp=50.0)


def mli(w, h, mat="mli_gold", loc=(0, 0, 0), rot=(0, 0, 0), n=(10, 10),
        t=0.008, amp=0.003, seed=0.0, margin=None):
    """Insulation blanket: a pillow in the XY plane with wrinkled foil.

    The border sits at z = 0, the field at z = t, and noise of height amp
    wrinkles the field. Normals face +Z.
    """
    nx, ny = n
    mg = margin if margin is not None else min(w, h) * 0.05
    xs = [-w / 2] + [-w / 2 + mg + (w - 2 * mg) * i / (nx - 2)
                     for i in range(nx - 1)] + [w / 2]
    ys = [-h / 2] + [-h / 2 + mg + (h - 2 * mg) * j / (ny - 2)
                     for j in range(ny - 1)] + [h / 2]
    cell = min(w / nx, h / ny)
    f = 1.0 / (2.7 * cell)
    bm = bmesh.new()
    grid = []
    for j, y in enumerate(ys):
        row = []
        for i, x in enumerate(xs):
            edge = min(i, nx - i, j, ny - j)
            if edge == 0:
                z = 0.0
            else:
                c = _crinkle(Vector((x * f, y * f, seed * 7.31 + 1.7)))
                z = t + amp * c * (0.5 if edge == 1 else 1.0)
            row.append(bm.verts.new((x, y, z)))
        grid.append(row)
    for j in range(ny):
        for i in range(nx):
            bm.faces.new((grid[j][i], grid[j][i + 1],
                          grid[j + 1][i + 1], grid[j + 1][i]))
    add(bm, mat, loc, rot, sharp=180.0)


def cells(w, h, nx, ny, gap, t, mat="solar_cell", loc=(0, 0, 0),
          rot=(0, 0, 0)):
    """Grid of raised solar cells in the XY plane, tops at z = t."""
    cw = (w - gap * (nx - 1)) / nx
    ch = (h - gap * (ny - 1)) / ny
    bm = bmesh.new()
    for i in range(nx):
        for j in range(ny):
            x0 = -w / 2 + i * (cw + gap)
            y0 = -h / 2 + j * (ch + gap)
            c = [(x0, y0), (x0 + cw, y0), (x0 + cw, y0 + ch), (x0, y0 + ch)]
            top = [bm.verts.new((x, y, t)) for x, y in c]
            bot = [bm.verts.new((x, y, 0.0)) for x, y in c]
            bm.faces.new(top)
            for k in range(4):
                k2 = (k + 1) % 4
                bm.faces.new((bot[k], bot[k2], top[k2], top[k]))
    add(bm, mat, loc, rot, smooth=False)


def bolts(radius, count, r, h, loc=(0, 0, 0), mat="alu", phase=0.0):
    """Ring of hexagonal bolt heads in the XY plane of the current frame."""
    for k in range(count):
        a = 2 * pi * k / count + radians(phase)
        cyl(r, h, (loc[0] + radius * cos(a), loc[1] + radius * sin(a),
                   loc[2]), mat=mat, n=6)


def blade(R, r0):
    """Rotor blade along +X from radius r0 to R, leading edge toward +Y.

    Cambered aerofoil sections with chord taper, thickness taper and
    washout twist. Slot 0 is the skin and slot 1 the leading-edge strip.
    """
    na = 8
    stations = [0.0, 0.03, 0.07, 0.12, 0.18, 0.25, 0.33, 0.42, 0.51, 0.60,
                0.69, 0.78, 0.85, 0.90, 0.93, 0.955, 0.975, 0.99, 1.0]

    def chord(s):
        cr, cm, ct = 0.028, 0.080, 0.036
        if s < 0.3:
            u = s / 0.3
            c = cr + (cm - cr) * u * u * (3 - 2 * u)
        else:
            c = cm - (cm - ct) * ((s - 0.3) / 0.7) ** 1.25
        if s > 0.9:
            u = (s - 0.9) / 0.1
            c *= sqrt(1.0 - 0.86 * u * u)
        return c

    def thick(xc, t):
        return 5 * t * (0.2969 * sqrt(xc) - 0.1260 * xc - 0.3516 * xc ** 2
                        + 0.2843 * xc ** 3 - 0.1036 * xc ** 4)

    bm = bmesh.new()
    rings = []
    for s in stations:
        c = chord(s)
        t = 0.24 - 0.15 * min(s / 0.3, 1.0) - 0.02 * s
        th = radians(21.0 - 15.0 * s)
        ring = []
        idx = list(range(na, -1, -1)) + list(range(1, na))
        for q, k in enumerate(idx):
            xc = 0.5 * (1 - cos(pi * k / na))
            zc = 4 * 0.035 * xc * (1 - xc)
            zt = thick(xc, t)
            z = (zc + zt if q <= na else zc - zt) * c
            y = (0.3 - xc) * c
            ring.append(bm.verts.new((r0 + s * (R - r0),
                                      y * cos(th) - z * sin(th),
                                      y * sin(th) + z * cos(th))))
        rings.append(ring)
    m = 2 * na
    for a, b in zip(rings[:-1], rings[1:]):
        for j in range(m):
            j2 = (j + 1) % m
            f = bm.faces.new((a[j], a[j2], b[j2], b[j]))
            if j in (na - 1, na):
                f.material_index = 1
    bm.faces.new(rings[0])
    bm.faces.new(rings[-1][::-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    add(bm, ["carbon", "leading_edge"], sharp=50.0)


# ---------------------------------------------------------------------------
# Rotorcraft. Origin at the fuselage centre, feet at z = -0.34.
# ---------------------------------------------------------------------------

RC_ROTOR_UP = 0.46
RC_ROTOR_LO = 0.34
RC_LIDAR = (0.0, -0.055, -0.201)
RC_LAMP_X = 0.092
RC_LAMP = (-0.1725, -0.154)   # y and z of the lamp lens centres
RC_FOOT_Z = -0.34


def _rotor(z, turn, mirror):
    """Hub, grips, pitch links and two blades at height z."""
    with frame(loc=(0, 0, z), rot=(0, 0, turn),
               scale=(1, -1 if mirror else 1, 1)):
        cyl(0.022, 0.034, mat="alu", n=28, bevel=0.003)
        cyl(0.013, 0.006, (0, 0, 0.019), mat="alu_dark", n=20, bevel=0.0015)
        bolts(0.016, 6, 0.0022, 0.002, (0, 0, 0.018), mat="alu_dark")
        tube(0.028, 0.013, 0.004, (0, 0, -0.034), mat="alu", n=28)
        for k in (0, 1):
            with frame(rot=(0, 0, 180 * k)):
                cyl(0.0085, 0.05, (0.042, 0, 0), (0, 90, 0), "alu_dark",
                    n=16, bevel=0.0015)
                box((0.020, 0.024, 0.013), (0.066, 0, 0), mat="alu",
                    bevel=0.002)
                bolts(0.0, 1, 0.003, 0.003, (0.066, 0, 0.0075),
                      mat="alu_dark")
                box((0.007, 0.024, 0.004), (0.034, 0.016, 0), mat="alu",
                    bevel=0.001)
                rod((0.034, 0.026, 0), (0.024, 0.012, -0.034), 0.0016,
                    "alu_dark", n=6)
                blade(0.6, 0.062)


def build_rotorcraft():
    W, L, H = 0.28, 0.32, 0.26
    hx, hy, hz = W / 2, L / 2, H / 2
    fr = 0.016

    use("body")
    # Avionics box: dark core, machined frame, blankets between the rails.
    box((W - 0.020, L - 0.020, H - 0.020), mat="alu_dark", bevel=0.006)
    for sx in (-1, 1):
        for sy in (-1, 1):
            box((fr, fr, H), (sx * (hx - fr / 2), sy * (hy - fr / 2), 0),
                mat="alu", bevel=0.0025)
    for sz in (-1, 1):
        for sx in (-1, 1):
            box((fr, L - 2 * fr, fr), (sx * (hx - fr / 2), 0,
                                       sz * (hz - fr / 2)),
                mat="alu", bevel=0.0025)
        for sy in (-1, 1):
            box((W - 2 * fr, fr, fr), (0, sy * (hy - fr / 2),
                                       sz * (hz - fr / 2)),
                mat="alu", bevel=0.0025)
    for i, ax in enumerate(("+x", "-x")):
        with face(ax, hx - 0.010):
            mli(H - 2 * fr + 0.004, L - 2 * fr + 0.004, "mli_gold",
                n=(18, 22), t=0.007, amp=0.0042, seed=1 + i)
            box((0.009, L - 2 * fr, 0.006), (0.012, 0, 0.009), mat="alu",
                bevel=0.0015)
            for u in (-0.068, 0.06):
                for v in (-0.09, 0.0, 0.09):
                    cyl(0.0042, 0.003, (u, v, 0.0105), mat="alu_dark", n=8)
            box((0.050, 0.070, 0.008), (-0.058, 0.045 - 0.09 * i, 0.011),
                mat="alu_dark", bevel=0.002)
    with face("-y", hy - 0.010):
        mli(W - 2 * fr + 0.004, H - 2 * fr + 0.004, "mli_silver",
            n=(20, 18), t=0.007, amp=0.0042, seed=3)
        for u in (-0.085, 0.085):
            for v in (-0.07, 0.075):
                cyl(0.0042, 0.003, (u, v, 0.0105), mat="alu_dark", n=8)
        for u in (-0.012, 0.012):
            cyl(0.0075, 0.012, (0.07 + u, -0.035, 0.012), mat="alu_dark",
                n=16, bevel=0.001)
            cyl(0.0055, 0.002, (0.07 + u, -0.035, 0.0185), mat="glass",
                n=16)
        box((0.050, 0.024, 0.010), (0.07, -0.035, 0.008), mat="alu",
            bevel=0.002)
    with face("-z", hz - 0.010):
        mli(W - 2 * fr + 0.004, L - 2 * fr + 0.004, "mli_gold",
            n=(16, 18), t=0.006, amp=0.0036, seed=4)
    # Top plate, patch antenna and frame bolts.
    box((W - 2 * fr + 0.002, L - 2 * fr + 0.002, 0.004),
        (0, 0, hz - 0.008), mat="carbon")
    box((0.052, 0.052, 0.005), (0.078, 0.095, hz - 0.004),
        mat="white_paint", bevel=0.0012)
    box((0.060, 0.060, 0.002), (0.078, 0.095, hz - 0.006), mat="alu")
    for sx in (-1, 1):
        for k in (-1, 0, 1):
            cyl(0.0032, 0.0025, (sx * (hx - fr / 2), k * 0.105, hz + 0.001),
                mat="alu_dark", n=6)
    for sy in (-1, 1):
        for k in (-1, 1):
            cyl(0.0032, 0.0025, (k * 0.07, sy * (hy - fr / 2), hz + 0.001),
                mat="alu_dark", n=6)
    # Rear radiator with fins and two connectors.
    with face("+y", hy - 0.010):
        box((W - 2 * fr - 0.004, H - 2 * fr - 0.004, 0.005), (0, 0, 0.0025),
            mat="white_paint", bevel=0.001)
        for k in range(11):
            box((W - 0.07, 0.0022, 0.007), (0, -0.072 + k * 0.0115, 0.008),
                mat="radiator")
        for k in (0, 1):
            cyl(0.0085, 0.014, (-0.085 + 0.03 * k, 0.088, 0.010),
                mat="alu", n=12, bevel=0.001)
            cyl(0.0065, 0.004, (-0.085 + 0.03 * k, 0.088, 0.018),
                mat="alu_dark", n=12)

    # Drive unit and mast.
    cyl(0.060, 0.006, (0, 0, hz - 0.004), mat="alu", n=36, bevel=0.0015)
    bolts(0.052, 8, 0.0032, 0.003, (0, 0, hz), mat="alu_dark")
    cyl(0.043, 0.050, (0, 0, hz + 0.024), mat="alu_dark", n=36, bevel=0.004)
    for k in range(6):
        cyl(0.047, 0.0022, (0, 0, hz + 0.006 + k * 0.0075), mat="alu", n=36)
    cyl(0.034, 0.030, (0, 0, hz + 0.064), mat="alu", n=32, bevel=0.002,
        r2=0.017)
    mast_lo = hz + 0.075
    mast_hi = 0.572
    cyl(0.0105, mast_hi - mast_lo, (0, 0, (mast_lo + mast_hi) / 2),
        mat="carbon", n=18)
    for zr in (RC_ROTOR_LO, RC_ROTOR_UP):
        # Fixed half of the swashplate, three servos and their pushrods.
        tube(0.030, 0.0125, 0.005, (0, 0, zr - 0.0395), mat="alu_dark", n=28)
        cyl(0.0175, 0.034, (0, 0, zr - 0.078), mat="alu", n=20, bevel=0.002)
        for k in range(3):
            with frame(rot=(0, 0, 120 * k + 30)):
                box((0.014, 0.022, 0.030), (0.027, 0, zr - 0.078),
                    mat="alu_dark", bevel=0.002)
                box((0.004, 0.006, 0.014), (0.030, 0, zr - 0.060),
                    mat="alu")
                rod((0.030, 0, zr - 0.056), (0.026, 0, zr - 0.042), 0.0016,
                    "alu", n=6)
    sweep([(0.012, 0.0, mast_lo + 0.004), (0.0125, 0.003, 0.24),
           (0.0125, 0.003, 0.36), (0.0125, 0.003, RC_ROTOR_UP - 0.09)],
          0.0022, "cable", n=5)

    # Solar panel on the mast head.
    cyl(0.017, 0.010, (0, 0, mast_hi), mat="alu", n=20, bevel=0.002)
    box((0.172, 0.142, 0.005), (0, 0, mast_hi + 0.0075), mat="carbon",
        bevel=0.0015)
    cells(0.162, 0.132, 4, 3, 0.003, 0.0013, loc=(0, 0, mast_hi + 0.010))

    # Landing legs with a damper brace and foot pad each.
    for sx in (-1, 1):
        for sy in (-1, 1):
            top = Vector((sx * (hx + 0.010), sy * (hy + 0.010), hz - 0.030))
            foot = Vector((sx * 0.30, sy * 0.30, RC_FOOT_Z + 0.012))
            low = Vector((sx * (hx + 0.004), sy * (hy + 0.004), -hz + 0.022))
            box((0.030, 0.030, 0.036), (sx * (hx + 0.002), sy * (hy + 0.002),
                                        hz - 0.030),
                (0, 0, 45), "alu", bevel=0.003)
            box((0.022, 0.022, 0.024), (sx * hx, sy * hy, -hz + 0.022),
                (0, 0, 45), "alu", bevel=0.002)
            rod(top, foot, 0.0065, "carbon", n=12, r2=0.0046)
            rod(top.lerp(foot, 0.0), top.lerp(foot, 0.07), 0.0090, "alu",
                n=12)
            mid = top.lerp(foot, 0.42)
            rod(top.lerp(foot, 0.40), top.lerp(foot, 0.44), 0.0088, "alu",
                n=12)
            rod(low, mid, 0.0032, "alu", n=8)
            rod(low.lerp(mid, 0.12), low.lerp(mid, 0.55), 0.0058,
                "alu_dark", n=10)
            rod(top.lerp(foot, 0.95), foot, 0.0062, "alu", n=12)
            lathe([(0, -0.012), (0.012, -0.012), (0.017, -0.007),
                   (0.017, -0.003), (0.008, 0.004), (0, 0.004)], "pad",
                  n=16, loc=foot)

    # Lidar mount under the body, fixed base with cooling fins.
    lx, ly, lz = RC_LIDAR
    box((0.074, 0.074, 0.005), (lx, ly, -hz + 0.0075), mat="alu",
        bevel=0.0015)
    with frame(loc=(lx, ly, -hz + 0.004)):
        bolts(0.044, 4, 0.003, 0.003, phase=45, mat="alu_dark")
    cyl(0.019, 0.022, (lx, ly, -hz - 0.005), mat="alu", n=24)
    cyl(0.0425, 0.024, (lx, ly, lz + 0.044), mat="alu_dark", n=40,
        bevel=0.002)
    for k in range(3):
        cyl(0.0447, 0.0022, (lx, ly, lz + 0.037 + k * 0.007), mat="alu",
            n=40)
    sweep([(0.062, hy - 0.014, -hz + 0.004), (0.062, 0.06, -hz - 0.002),
           (0.035, -0.01, -hz - 0.002), (0.024, ly + 0.012, -hz - 0.004),
           (0.022, ly + 0.012, lz + 0.046)], 0.003, "cable", n=6)

    # Lamp bar, two housings with fins, navigation cameras, antennas.
    ly_l, lz_l = RC_LAMP
    box((0.25, 0.012, 0.010), (0, -hy + 0.010, -hz - 0.004), mat="alu",
        bevel=0.002)
    for sx in (-1, 1):
        x = sx * RC_LAMP_X
        box((0.012, 0.012, 0.016), (x, -hy + 0.010, -hz - 0.012), mat="alu",
            bevel=0.0015)
        cyl(0.0165, 0.032, (x, ly_l + 0.0175, lz_l), (90, 0, 0), "alu_dark",
            n=24, bevel=0.002)
        for k in range(3):
            cyl(0.0195, 0.002, (x, ly_l + 0.020 + k * 0.005, lz_l),
                (90, 0, 0), "alu", n=24)
    box((0.050, 0.018, 0.038), (0, -hy + 0.002, 0.030), mat="alu_dark",
        bevel=0.003)
    cyl(0.0115, 0.014, (0, -hy - 0.012, 0.030), (90, 0, 0), "alu", n=24,
        bevel=0.0015)
    cyl(0.0085, 0.002, (0, -hy - 0.0195, 0.030), (90, 0, 0), "glass", n=24)
    cyl(0.013, 0.012, (0, 0.09, -hz + 0.002), mat="alu_dark", n=20,
        bevel=0.0015)
    cyl(0.009, 0.002, (0, 0.09, -hz - 0.0045), (180, 0, 0), "glass", n=20)
    cyl(0.006, 0.012, (-0.095, 0.115, hz), mat="alu", n=12, bevel=0.001)
    rod((-0.095, 0.115, hz + 0.006), (-0.095, 0.115, hz + 0.16), 0.0022,
        "alu_dark", n=6)
    box((0.003, 0.030, 0.055), (0.11, 0.12, hz + 0.027), mat="alu_dark",
        bevel=0.001)

    # Spinning lidar head with an off-centre window so the spin shows.
    use("lidar_head")
    with frame(loc=RC_LIDAR):
        cyl(0.0425, 0.008, (0, 0, 0.027), mat="alu_dark", n=40, bevel=0.0015)
        cyl(0.0412, 0.040, (0, 0, 0.003), mat="glass", n=40)
        cyl(0.0425, 0.016, (0, 0, -0.023), mat="alu_dark", n=40, bevel=0.004)
        box((0.0035, 0.004, 0.040), (0, -0.0405, 0.003), mat="alu")
        for sx in (-1, 1):
            box((0.012, 0.003, 0.030), (sx * 0.0105, -0.0398, 0.003),
                (0, 0, sx * 14.5), "black_matte")
        cyl(0.007, 0.002, (0.022, 0.0, -0.0315), mat="alu", n=12)
        bolts(0.033, 4, 0.0025, 0.002, (0, 0, -0.0315), mat="alu", phase=45)

    use("rotor_upper")
    _rotor(RC_ROTOR_UP, 0, False)
    use("rotor_lower")
    _rotor(RC_ROTOR_LO, 90, True)
    for name, z in (("rotor_disc_upper", RC_ROTOR_UP),
                    ("rotor_disc_lower", RC_ROTOR_LO)):
        use(name)
        lathe([(0.03, z), (0.32, z), (0.6, z)], "rotor_blur", n=64,
              closed=False, flip=True, sharp=180.0)

    for name, sx in (("lamp_l", 1), ("lamp_r", -1)):
        use(name)
        cyl(0.0135, 0.003, (sx * RC_LAMP_X, ly_l, lz_l), (90, 0, 0), "lamp",
            n=24, bevel=0.0008)

    return {
        "body": (0, 0, 0),
        "rotor_upper": (0, 0, RC_ROTOR_UP),
        "rotor_lower": (0, 0, RC_ROTOR_LO),
        "rotor_disc_upper": (0, 0, RC_ROTOR_UP),
        "rotor_disc_lower": (0, 0, RC_ROTOR_LO),
        "lidar_head": RC_LIDAR,
        "lamp_l": (RC_LAMP_X, ly_l, lz_l),
        "lamp_r": (-RC_LAMP_X, ly_l, lz_l),
    }


# ---------------------------------------------------------------------------
# Lander. Origin on the ground under the centre, deck surface at z = 0.90.
# ---------------------------------------------------------------------------

LD_DECK_Z = 0.90
LD_DISH = (0.40, 0.60, 1.385)
LD_LIGHT = (0.0, -0.776, 0.857)


def build_lander():
    R = 0.80
    c8 = cos(pi / 8)
    z0, z1 = 0.36, 0.84
    zc, hh = (z0 + z1) / 2, z1 - z0
    ap_core = (R - 0.02) * c8

    use("body")
    # Octagonal bus: core, top and bottom rings, corner posts, blankets.
    cyl(R - 0.02, hh - 0.02, (0, 0, zc), (0, 0, 22.5), "alu_dark", n=8,
        bevel=0.01)
    for z in (z0 + 0.015, z1 - 0.015):
        cyl(R, 0.03, (0, 0, z), (0, 0, 22.5), "alu", n=8, bevel=0.006)
    for k in range(8):
        with frame(rot=(0, 0, 45 * k)):
            with frame(rot=(0, 0, 22.5)):
                box((0.034, 0.034, hh - 0.06), (0, -(R - 0.014), zc),
                    mat="alu", bevel=0.005)
            mli(0.560, hh - 0.075, "mli_silver" if k in (0, 4) else
                "mli_gold", loc=(0, -ap_core, zc), rot=(90, 0, 0),
                n=(16, 12), t=0.018, amp=0.011, seed=20 + k)

    # Four legs on the diagonals: sleeve, piston, braces, pad.
    for k in (1, 3, 5, 7):
        with frame(rot=(0, 0, 45 * k)):
            top = Vector((0, -0.775, 0.765))
            ank = Vector((0, -1.05, 0.085))
            box((0.13, 0.07, 0.09), (0, -0.765, 0.765), mat="alu",
                bevel=0.008)
            rod(top, top.lerp(ank, 0.56), 0.034, "alu", n=14)
            rod(top.lerp(ank, 0.08), top.lerp(ank, 0.46), 0.039, "mli_gold",
                n=14)
            rod(top.lerp(ank, 0.53), top.lerp(ank, 0.585), 0.042, "alu_dark",
                n=14)
            rod(top.lerp(ank, 0.55), ank, 0.022, "alu", n=12)
            low = top.lerp(ank, 0.82)
            for sx in (-1, 1):
                a = Vector((sx * 0.27, -0.728, z0 + 0.025))
                box((0.06, 0.05, 0.05), a, mat="alu", bevel=0.005)
                rod(a, low, 0.013, "alu", n=8)
            rod(top.lerp(ank, 0.79), top.lerp(ank, 0.85), 0.030, "alu_dark",
                n=12)
            lathe([(0, 0.0), (0.13, 0.0), (0.165, 0.018), (0.172, 0.045),
                   (0.158, 0.047), (0.125, 0.026), (0, 0.026)], "alu",
                  n=24, loc=(0, -1.05, 0))
            lathe([(0, 0.024), (0.030, 0.036), (0.042, 0.070),
                   (0.030, 0.104), (0, 0.112)], "alu_dark", n=14,
                  loc=(0, -1.05, 0))

    # Deck supports between the bus top and the deck.
    cyl(0.26, 0.03, (0, 0, z1 + 0.014), mat="alu_dark", n=24)
    for k in range(8):
        a = radians(45 * k)
        cyl(0.022, 0.03, (0.58 * cos(a), 0.58 * sin(a), z1 + 0.014),
            mat="alu", n=10)

    # Two fold-out solar wings on the +X and -X sides, two segments each.
    for k in (2, 6):
        with frame(rot=(0, 0, 45 * k)):
            for sx in (-1, 1):
                box((0.05, 0.10, 0.045), (sx * 0.24, -0.78, 0.795),
                    mat="alu", bevel=0.005)
            rod((-0.32, -0.825, 0.795), (0.32, -0.825, 0.795), 0.012,
                "alu_dark", n=10)
            for s in (0, 1):
                yc = -(0.845 + 0.225 + s * 0.475)
                box((1.10, 0.45, 0.014), (0, yc, 0.795), mat="solar_back",
                    bevel=0.003)
                cells(1.07, 0.42, 10, 4, 0.010, 0.004,
                      loc=(0, yc, 0.802))
                for sx in (-1, 1):
                    box((0.022, 0.45, 0.022), (sx * 0.36, yc, 0.777),
                        mat="alu_dark")
            for x in (-0.4, 0.0, 0.4):
                cyl(0.012, 0.09, (x, -(0.845 + 0.45 + 0.0125), 0.795),
                    (0, 90, 0), "alu", n=10)
            for sx in (-1, 1):
                rod((sx * 0.2, -0.735, z0 + 0.04), (sx * 0.36, -1.02, 0.772),
                    0.011, "alu", n=8)

    # Stowed ramp on the front, folded in two against the bus.
    for sx in (-1, 1):
        box((0.030, 0.034, 0.44), (sx * 0.215, -0.782, zc), mat="alu",
            bevel=0.004)
        box((0.026, 0.028, 0.40), (sx * 0.190, -0.816, zc + 0.01), mat="alu",
            bevel=0.004)
        box((0.05, 0.05, 0.04), (sx * 0.215, -0.775, z1 - 0.05),
            mat="alu_dark", bevel=0.004)
    box((0.40, 0.008, 0.43), (0, -0.770, zc), mat="alu_dark")
    box((0.35, 0.006, 0.39), (0, -0.806, zc + 0.01), mat="deck")
    for i in range(5):
        box((0.33, 0.008, 0.010), (0, -0.812, zc - 0.15 + i * 0.08),
            mat="alu")
    cyl(0.018, 0.48, (0, -0.785, z0 + 0.012), (0, 90, 0), "alu_dark", n=12,
        bevel=0.003)
    # Housing of the beacon strip above the ramp.
    box((0.54, 0.034, 0.030), (0, -0.757, LD_LIGHT[2]), mat="alu_dark",
        bevel=0.004)

    # Equipment box with louvres on the rear face, cables to the bus top.
    box((0.50, 0.20, 0.30), (0, 0.845, zc + 0.03), mat="white_paint",
        bevel=0.012)
    box((0.44, 0.012, 0.24), (0, 0.949, zc + 0.03), mat="alu_dark")
    for i in range(8):
        box((0.42, 0.020, 0.004), (0, 0.958, zc - 0.07 + i * 0.03),
            (-30, 0, 0), "radiator")
    for sx in (-1, 1):
        box((0.04, 0.06, 0.04), (sx * 0.2, 0.76, zc + 0.20), mat="alu",
            bevel=0.004)
        sweep([(sx * 0.12, 0.845, zc + 0.18), (sx * 0.12, 0.845, zc + 0.215),
               (sx * 0.12, 0.775, zc + 0.225), (sx * 0.12, 0.70, z1 + 0.01)],
              0.010, "cable", n=6)

    # Mast for the dish, with the azimuth drive and yoke.
    mx, my, mz = LD_DISH
    box((0.09, 0.09, 0.05), (mx, my, z1 + 0.02), mat="alu", bevel=0.006)
    rod((mx, my, z1), (mx, my, mz - 0.11), 0.022, "alu", n=12)
    rod((mx, my, z1 + 0.10), (mx, my, z1 + 0.30), 0.026, "mli_gold", n=12)
    cyl(0.042, 0.055, (mx, my, mz - 0.085), mat="alu_dark", n=18,
        bevel=0.004)
    box((0.13, 0.036, 0.014), (mx, my, mz - 0.053), mat="alu", bevel=0.002)
    for sx in (-1, 1):
        box((0.012, 0.036, 0.085), (mx + sx * 0.059, my, mz - 0.012),
            mat="alu", bevel=0.002)
    # Low-gain antenna, camera post, descent thrusters and tank.
    rod((-0.40, 0.60, z1), (-0.40, 0.60, 1.00), 0.012, "alu", n=8)
    cyl(0.040, 0.012, (-0.40, 0.60, 1.004), mat="alu_dark", n=16)
    cyl(0.034, 0.10, (-0.40, 0.60, 1.058), mat="white_paint", n=16,
        bevel=0.004, r2=0.020)
    rod((0.46, -0.56, z1), (0.46, -0.56, 1.02), 0.012, "alu", n=8)
    box((0.09, 0.07, 0.065), (0.46, -0.565, 1.05), mat="alu_dark",
        bevel=0.006)
    cyl(0.022, 0.03, (0.46, -0.61, 1.05), (90, 0, 0), "alu", n=16,
        bevel=0.002)
    cyl(0.016, 0.004, (0.46, -0.626, 1.05), (90, 0, 0), "glass", n=16)
    lathe([(0, 0.17), (0.15, 0.188), (0.26, 0.24), (0.325, 0.31),
           (0.345, 0.372), (0, 0.372)], "mli_gold", n=28, crinkle=0.012,
          cfreq=9.0, seed=3.0)
    for k in range(4):
        a = radians(90 * k)
        with frame(loc=(0.52 * cos(a), 0.52 * sin(a), 0)):
            shell([(0.034, 0.375), (0.028, 0.335), (0.060, 0.235)], 0.006,
                  "nozzle", "nozzle", n=16)
            cyl(0.045, 0.02, (0, 0, 0.372), mat="alu_dark", n=16)

    # Landing deck: plate, rim, painted rings and ticks, foot cups, cleats.
    use("deck")
    dz = LD_DECK_Z
    cyl(0.70, 0.03, (0, 0, dz - 0.015), (0, 0, 22.5), "deck", n=8,
        bevel=0.004)
    lathe([(0.668, dz - 0.002), (0.704, dz - 0.002), (0.704, dz + 0.014),
           (0.668, dz + 0.014)], "alu", n=8, rot=(0, 0, 22.5), sharp=20.0)
    tube(0.515, 0.500, 0.008, (0, 0, dz), mat="white_paint", n=56)
    tube(0.172, 0.160, 0.008, (0, 0, dz), mat="white_paint", n=36)
    for k in range(4):
        with frame(rot=(0, 0, 90 * k)):
            box((0.014, 0.085, 0.008), (0, -0.585, dz), mat="white_paint")
    for sx in (-1, 1):
        box((0.014, 0.085, 0.008), (sx * 0.035, -0.585, dz),
            mat="white_paint")
    for sx in (-1, 1):
        for sy in (-1, 1):
            tube(0.046, 0.034, 0.012, (sx * 0.30, sy * 0.30, dz), mat="alu",
                 n=20)
    for k in range(4):
        with frame(rot=(0, 0, 90 * k + 45)):
            box((0.05, 0.016, 0.016), (0, -0.60, dz + 0.004), mat="alu_dark",
                bevel=0.003)

    # High-gain dish above the elevation pivot. Boresight is local +Z.
    use("dish")
    with frame(loc=LD_DISH):
        cyl(0.016, 0.106, rot=(0, 90, 0), mat="alu_dark", n=12)
        box((0.034, 0.034, 0.052), (0, 0, 0.026), mat="alu", bevel=0.003)
        cyl(0.050, 0.020, (0, 0, 0.052), mat="alu", n=20, bevel=0.002)
        zv, f = 0.058, 0.15
        prof = [(r, zv + r * r / (4 * f)) for r in
                (0.0, 0.045, 0.09, 0.13, 0.17, 0.21)]
        shell(prof, 0.006, "white_paint", "white_paint", n=32)
        for k in range(3):
            a = radians(120 * k + 90)
            rs = 0.17
            rod((rs * cos(a), rs * sin(a), zv + rs * rs / (4 * f)),
                (0.016 * cos(a), 0.016 * sin(a), zv + f + 0.01), 0.0035,
                "alu", n=6)
        cyl(0.020, 0.034, (0, 0, zv + f + 0.012), mat="alu_dark", n=14,
            bevel=0.002)

    use("ramp_light")
    box((0.50, 0.008, 0.014), LD_LIGHT, mat="beacon")

    return {"body": (0, 0, 0), "deck": (0, 0, LD_DECK_Z), "dish": LD_DISH,
            "ramp_light": LD_LIGHT}


# ---------------------------------------------------------------------------
# Orbiter. Origin at the bus centre, nadir is -Z, arrays along X.
# ---------------------------------------------------------------------------

OR_H = (1.1, 1.4, 1.2)                 # bus half sizes
OR_ARRAY_X = 1.27
OR_HGA = (0.0, 0.45, 2.34)
OR_TEL = (0.0, -0.45, -2.62)


def _thruster(n=14):
    shell([(0.022, 0.0), (0.027, 0.03), (0.052, 0.115)], 0.004, "nozzle",
          "nozzle", n=n)


def _array():
    """One solar wing built along local +X from the drive shaft at x = 0."""
    cyl(0.055, 0.14, (0.07, 0, 0), (0, 90, 0), "alu", n=20, bevel=0.006)
    box((0.14, 0.26, 0.10), (0.17, 0, 0), mat="alu_dark", bevel=0.012)
    x1 = 0.66
    for sy in (-1, 1):
        rod((0.20, sy * 0.09, 0), (x1 - 0.02, sy * 0.80, 0), 0.026,
            "carbon", n=10)
        box((0.07, 0.10, 0.07), (x1 - 0.03, sy * 0.80, 0), mat="alu",
            bevel=0.008)
    rod((x1 - 0.03, -0.80, 0), (x1 - 0.03, 0.80, 0), 0.020, "carbon", n=10)
    pl, pw, gap = 1.5, 2.3, 0.04
    for i in range(3):
        xc = x1 + pl / 2 + i * (pl + gap)
        box((pl, pw, 0.028), (xc, 0, 0), mat="solar_back", bevel=0.005)
        cells(pl - 0.05, pw - 0.05, 6, 10, 0.016, 0.006,
              loc=(xc, 0, 0.014))
        for y in (-0.72, 0.0, 0.72):
            box((pl - 0.06, 0.035, 0.025), (xc, y, -0.026), mat="alu_dark")
        box((0.035, pw - 0.06, 0.025), (xc, 0, -0.026), mat="alu_dark")
        xh = x1 + i * (pl + gap) - gap / 2
        for y in (-0.80, 0.0, 0.80):
            if i > 0:
                cyl(0.024, 0.13, (xh, y, -0.004), (90, 0, 0), "alu", n=10)
    sweep([(0.24, 0.05, -0.03), (x1, 0.30, -0.035), (x1 + 0.2, 0.36, -0.045),
           (x1 + 3 * pl + 2 * gap - 0.1, 0.36, -0.045)], 0.014, "cable", n=5)


def build_orbiter():
    hx, hy, hz = OR_H
    b = 0.07
    inset = 0.03
    d = {"+x": hx - inset, "-x": hx - inset, "+y": hy - inset,
         "-y": hy - inset, "+z": hz - inset, "-z": hz - inset}
    mk = dict(t=0.034, amp=0.022)

    use("bus")
    box((2 * hx - 2 * inset, 2 * hy - 2 * inset, 2 * hz - 2 * inset),
        mat="alu_dark", bevel=0.02)
    for sy in (-1, 1):
        for sz in (-1, 1):
            box((2 * hx, b, b), (0, sy * (hy - b / 2), sz * (hz - b / 2)),
                mat="alu", bevel=0.010)
    for sx in (-1, 1):
        for sz in (-1, 1):
            box((b, 2 * hy - 2 * b, b), (sx * (hx - b / 2), 0,
                                         sz * (hz - b / 2)),
                mat="alu", bevel=0.010)
        for sy in (-1, 1):
            box((b, b, 2 * hz - 2 * b), (sx * (hx - b / 2),
                                         sy * (hy - b / 2), 0),
                mat="alu", bevel=0.010)

    # Side faces: four gold blankets around the array drive.
    for i, ax in enumerate(("+x", "-x")):
        with face(ax, d[ax]):
            for sa in (-1, 1):
                for sb in (-1, 1):
                    mli(1.125, 1.325, "mli_gold", (sa * 0.5675, sb * 0.6675,
                                                   0),
                        n=(15, 18), seed=40 + 7 * i + 2 * sa + sb, **mk)
            cyl(0.27, 0.035, (0, 0, 0.0175), mat="alu", n=32, bevel=0.006)
            bolts(0.235, 10, 0.014, 0.012, (0, 0, 0.04), mat="alu_dark")
            cyl(0.19, 0.20, (0, 0, 0.10), mat="alu", n=32, bevel=0.015)
            cyl(0.10, 0.03, (0, 0, 0.212), mat="alu_dark", n=24)
            box((0.42, 0.34, 0.07), (0.72, -0.85, 0.045), mat="radiator",
                bevel=0.008)
            box((0.22, 0.30, 0.12), (-0.70, 0.95, 0.07), mat="alu_dark",
                bevel=0.012)
            sweep([(0, 0.20, 0.03), (0.0, 0.70, 0.045), (-0.55, 0.95, 0.045),
                   (-0.62, 0.95, 0.06)], 0.016, "cable", n=5)

    # Forward face: silver blankets, louvred radiator, star trackers.
    with face("-y", d["-y"]):
        mli(2.05, 0.66, "mli_silver", (0, 0.795, 0), n=(26, 9), seed=51,
            **mk)
        mli(1.02, 1.58, "mli_silver", (0.515, -0.335, 0), n=(14, 20),
            seed=52, **mk)
        box((1.00, 1.56, 0.05), (-0.525, -0.335, 0.025), mat="white_paint",
            bevel=0.008)
        for col in (-1, 1):
            for i in range(11):
                box((0.44, 0.105, 0.006), (-0.525 + col * 0.235,
                                           -1.01 + i * 0.135, 0.068),
                    (24, 0, 0), "radiator")
        box((0.03, 1.50, 0.035), (-0.525, -0.335, 0.062), mat="alu")
        for sx in (-1, 1):
            box((0.20, 0.20, 0.16), (sx * 0.55, 0.82, 0.08), mat="alu_dark",
                bevel=0.012)
            with frame(loc=(sx * 0.55, 0.84, 0.15), rot=(-38, sx * 14, 0)):
                cyl(0.085, 0.07, (0, 0, 0.03), mat="alu", n=20, bevel=0.006)
                shell([(0.070, 0.06), (0.125, 0.36)], 0.008, "white_paint",
                      "black_matte", n=24)
                cyl(0.066, 0.004, (0, 0, 0.068), mat="glass", n=20)

    # Aft face: blankets, heat shield, main engine, thrust struts.
    with face("+y", d["+y"]):
        for sa in (-1, 1):
            for sb in (-1, 1):
                mli(1.025, 1.125, "mli_gold", (sa * 0.5175, sb * 0.5675, 0),
                    n=(14, 15), seed=60 + 2 * sa + sb, **mk)
        # Propulsion module: wrapped drum, heat shield, engine bell.
        lathe([(0.80, 0.0), (0.80, 0.14), (0.78, 0.28), (0.70, 0.40),
               (0.52, 0.44)], "mli_gold", n=40, closed=False, crinkle=0.02,
              cfreq=7.0, seed=9.0, sharp=180.0)
        tube(0.82, 0.76, 0.04, (0, 0, 0.02), mat="alu", n=40, bevel=0.006)
        cyl(0.54, 0.04, (0, 0, 0.43), mat="mli_silver", n=40, bevel=0.008)
        bolts(0.47, 12, 0.016, 0.012, (0, 0, 0.455), mat="alu_dark")
        cyl(0.13, 0.12, (0, 0, 0.50), mat="alu", n=24, bevel=0.008)
        for k in range(4):
            a = radians(90 * k + 45)
            rod((0.36 * cos(a), 0.36 * sin(a), 0.45),
                (0.20 * cos(a), 0.20 * sin(a), 0.80), 0.014, "alu", n=6)
        shell([(0.085, 0.54), (0.10, 0.60), (0.19, 0.74), (0.29, 0.94),
               (0.365, 1.16), (0.41, 1.40)], 0.012, "nozzle", "nozzle",
              n=40)
        tube(0.425, 0.405, 0.03, (0, 0, 1.39), mat="nozzle", n=40)
        tube(0.215, 0.185, 0.03, (0, 0, 0.80), mat="alu", n=32)

    # Zenith face: silver blankets, radiator, antenna boom and gimbal.
    with face("+z", d["+z"]):
        for sa in (-1, 1):
            mli(1.025, 2.65, "mli_silver", (sa * 0.5175, 0, 0), n=(11, 26),
                seed=70 + sa, **mk)
        box((0.80, 0.90, 0.05), (-0.52, -0.80, 0.03), mat="white_paint",
            bevel=0.008)
        for i in range(7):
            box((0.72, 0.095, 0.006), (-0.52, -1.16 + i * 0.12, 0.07),
                (24, 0, 0), "radiator")
        bx, by = OR_HGA[0], OR_HGA[1]
        box((0.40, 0.40, 0.10), (bx, by, 0.05), mat="alu", bevel=0.012)
        bolts(0.24, 4, 0.016, 0.012, (bx, by, 0.105), mat="alu_dark",
              phase=45)
        cyl(0.075, 0.76, (bx, by, 0.48), mat="alu_dark", n=18)
        cyl(0.082, 0.38, (bx, by, 0.50), mat="mli_gold", n=18)
        for k in range(4):
            a = radians(90 * k + 45)
            rod((bx + 0.17 * cos(a), by + 0.17 * sin(a), 0.10),
                (bx + 0.07 * cos(a), by + 0.07 * sin(a), 0.42), 0.014,
                "alu", n=6)
        cyl(0.125, 0.16, (bx, by, 0.93), mat="alu", n=24, bevel=0.012)
        box((0.50, 0.16, 0.035), (bx, by, 1.025), mat="alu", bevel=0.006)
        for sx in (-1, 1):
            box((0.045, 0.16, 0.22), (bx + sx * 0.225, by, 1.13), mat="alu",
                bevel=0.008)
        # Low-gain antenna and a sun sensor.
        rod((0.75, -1.05, 0.0), (0.75, -1.05, 0.30), 0.02, "alu", n=8)
        cyl(0.07, 0.16, (0.75, -1.05, 0.38), mat="white_paint", n=16,
            bevel=0.006, r2=0.035)
        box((0.10, 0.10, 0.07), (0.80, 1.10, 0.05), mat="alu_dark",
            bevel=0.008)
        sweep([(bx + 0.21, by, 0.03), (0.60, by, 0.045), (0.92, 0.2, 0.045),
               (0.92, -1.2, 0.045)], 0.016, "cable", n=5)

    # Nadir deck: dark blankets, telescope seat, two small instruments.
    with face("-z", d["-z"]):
        for sa in (-1, 1):
            mli(1.025, 2.65, "mli_black", (sa * 0.5175, 0, 0), n=(9, 22),
                seed=80 + sa, **mk)
        tx, ty = OR_TEL[0], -OR_TEL[1]
        tube(0.56, 0.40, 0.07, (tx, ty, 0.045), mat="alu", n=40, bevel=0.008)
        bolts(0.51, 12, 0.016, 0.012, (tx, ty, 0.085), mat="alu_dark")
        box((0.50, 0.44, 0.40), (0.62, -0.86, 0.22), mat="mli_gold",
            bevel=0.03, segs=3)
        cyl(0.10, 0.26, (0.62, -0.86, 0.53), mat="alu_dark", n=20,
            bevel=0.006)
        cyl(0.085, 0.004, (0.62, -0.86, 0.661), mat="glass", n=20)
        box((0.30, 0.30, 0.24), (-0.66, -0.92, 0.14), mat="white_paint",
            bevel=0.015)
        cyl(0.06, 0.10, (-0.66, -0.92, 0.30), mat="alu_dark", n=16,
            bevel=0.004)
        cyl(0.048, 0.004, (-0.66, -0.92, 0.351), mat="glass", n=16)
        rod((-0.80, 0.95, 0.0), (-0.80, 0.95, 0.22), 0.02, "alu", n=8)
        cyl(0.07, 0.16, (-0.80, 0.95, 0.30), mat="white_paint", n=16,
            bevel=0.006, r2=0.035)
        sweep([(0.40, -0.80, 0.04), (0.20, -0.55, 0.05), (0.25, 0.0, 0.05),
               (tx + 0.50, ty - 0.2, 0.05)], 0.018, "cable", n=5)
        sweep([(-0.52, -0.86, 0.04), (-0.35, -0.5, 0.05),
               (tx - 0.52, ty - 0.1, 0.05)], 0.018, "cable", n=5)

    # Thruster clusters at the eight corners and brackets along the beams.
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                c = Vector((sx * (hx + 0.06), sy * (hy - 0.24),
                            sz * (hz - 0.24)))
                box((0.16, 0.22, 0.22), c, mat="alu_dark", bevel=0.012)
                with frame(loc=c + Vector((sx * 0.07, 0, 0)),
                           rot=(0, sx * 90, 0)):
                    _thruster()
                with frame(loc=c + Vector((0, 0, sz * 0.10)),
                           rot=(0 if sz > 0 else 180, 0, 0)):
                    _thruster()
                if sy > 0:
                    with frame(loc=c + Vector((0, sy * 0.10, 0)),
                               rot=(-90 * sy, 0, 0)):
                        _thruster()
    for sx in (-1, 1):
        for sz in (-1, 1):
            for k in range(5):
                box((0.09, 0.10, 0.03), (sx * (hx - b / 2), -0.8 + 0.4 * k,
                                         sz * (hz + 0.012)), mat="alu_dark")
    for sy in (-1, 1):
        for sz in (-1, 1):
            for k in range(4):
                box((0.10, 0.03, 0.09), (-0.6 + 0.4 * k, sy * (hy + 0.012),
                                         sz * (hz - b / 2)), mat="alu_dark")

    # Solar wings. Cells face +Z in the rest pose.
    use("array_l")
    with frame(loc=(OR_ARRAY_X, 0, 0)):
        _array()
    use("array_r")
    with frame(loc=(-OR_ARRAY_X, 0, 0), rot=(0, 0, 180)):
        _array()

    # High-gain antenna. Boresight is local +Z in the rest pose.
    use("hga")
    with frame(loc=OR_HGA):
        cyl(0.062, 0.405, rot=(0, 90, 0), mat="alu_dark", n=18, bevel=0.006)
        box((0.32, 0.30, 0.15), (0, 0, 0.10), mat="alu_dark", bevel=0.015)
        cyl(0.30, 0.10, (0, 0, 0.215), mat="alu", n=32, bevel=0.01)
        zv, f = 0.25, 1.1

        def zd(r):
            return zv + r * r / (4 * f)

        shell([(r, zd(r)) for r in (0.0, 0.2, 0.45, 0.7, 0.95, 1.2, 1.4,
                                    1.5)], 0.028, "carbon", "white_paint",
              n=56)
        tube(1.512, 1.478, 0.045, (0, 0, zd(1.5) - 0.012), mat="alu", n=56)
        for k in range(12):
            with frame(rot=(0, 0, 30 * k)):
                sweep([(r, 0, zd(r) - 0.055) for r in
                       (0.28, 0.6, 0.9, 1.2, 1.46)], 0.024, "alu", n=4)
        for rr in (0.62, 1.10):
            tube(rr + 0.02, rr - 0.02, 0.04, (0, 0, zd(rr) - 0.06),
                 mat="alu", n=40)
        zs = zv + 1.02
        for k in range(4):
            a = radians(90 * k + 45)
            rod((1.0 * cos(a), 1.0 * sin(a), zd(1.0) - 0.01),
                (0.12 * cos(a), 0.12 * sin(a), zs), 0.014, "alu", n=6)
        lathe([(0, -0.06), (0.10, -0.035), (0.175, 0.0), (0.175, 0.025),
               (0, 0.025)], "white_paint", n=28, loc=(0, 0, zs))
        cyl(0.10, 0.34, (0, 0, zv + 0.17), mat="alu", n=24, r2=0.045)
        cyl(0.13, 0.03, (0, 0, zv + 0.02), mat="alu_dark", n=24)

    # Telescope. Local +Z of this frame is the view direction (world -Z),
    # the aperture plane is z = 0 and the barrel runs back to z = -1.45.
    use("telescope")
    with frame(loc=OR_TEL, rot=(180, 0, 0)):
        nz = 9
        lathe([(0.412, -1.45 + 1.43 * i / (nz - 1)) for i in range(nz)],
              "mli_silver", n=44, closed=False, crinkle=0.014, cfreq=4.0,
              seed=5.0, sharp=180.0)
        tube(0.438, 0.360, 0.035, (0, 0, -0.0175), mat="alu", n=44,
             bevel=0.005)
        for z in (-0.50, -0.98):
            tube(0.432, 0.40, 0.04, (0, 0, z), mat="alu", n=44, bevel=0.005)
        tube(0.48, 0.40, 0.05, (0, 0, -1.40), mat="alu", n=44, bevel=0.006)
        lathe([(0.36, -0.03), (0.36, -1.25)], "black_matte", n=44,
              closed=False, sharp=180.0)
        for z in (-0.32, -0.62, -0.92):
            lathe([(0.36, z), (0.325, z)], "black_matte", n=44, closed=False)
        lathe([(0.36, -1.25), (0.085, -1.25)], "mirror", n=44, closed=False)
        cyl(0.07, 0.30, (0, 0, -1.10), mat="black_matte", n=20, r2=0.085)
        cyl(0.105, 0.09, (0, 0, -0.21), mat="black_matte", n=24)
        for k in range(4):
            with frame(rot=(0, 0, 90 * k + 45)):
                box((0.27, 0.007, 0.07), (0.232, 0, -0.21),
                    mat="black_matte")
        # Sunshade with a slanted lip, long side toward the flight direction.
        ns = 44
        bm = bmesh.new()
        rings = [[], [], [], []]
        for i in range(ns):
            a = 2 * pi * i / ns
            ze = 0.10 + 0.32 * (0.5 + 0.5 * cos(a - pi / 2))
            for q, (zz, th) in enumerate(((0.0, 0.0), (ze, 0.0), (ze, 0.014),
                                          (0.0, 0.014))):
                r = 0.440 + 0.085 * zz - th
                rings[q].append(bm.verts.new((r * cos(a), r * sin(a), zz)))
        for q in range(3):
            for i in range(ns):
                i2 = (i + 1) % ns
                fc = bm.faces.new((rings[q][i], rings[q][i2],
                                   rings[q + 1][i2], rings[q + 1][i]))
                fc.material_index = 1 if q == 2 else 0
        add(bm, ["white_paint", "black_matte"])
        # Electronics box, cooler, and bipods down to the deck.
        box((0.24, 0.34, 0.50), (0.535, 0.0, -1.05), mat="alu_dark",
            bevel=0.015)
        box((0.012, 0.30, 0.44), (0.66, 0.0, -1.05), mat="radiator")
        cyl(0.07, 0.30, (-0.50, 0.0, -1.15), mat="alu", n=16, bevel=0.008)
        for k in range(3):
            a0 = radians(120 * k + 90)
            for da in (-22, 22):
                a1 = a0 + radians(da)
                rod((0.425 * cos(a0), 0.425 * sin(a0), -0.52),
                    (0.60 * cos(a1), 0.60 * sin(a1), -1.44), 0.016, "carbon",
                    n=6)
            box((0.09, 0.09, 0.06), (0.445 * cos(a0), 0.445 * sin(a0),
                                     -0.52), (0, 0, 120 * k + 90), "alu",
                bevel=0.008)

    return {"bus": (0, 0, 0), "array_l": (OR_ARRAY_X, 0, 0),
            "array_r": (-OR_ARRAY_X, 0, 0), "hga": OR_HGA,
            "telescope": OR_TEL}


# ---------------------------------------------------------------------------
# Assembly, ambient occlusion, export, previews
# ---------------------------------------------------------------------------

BUILDERS = {
    # name: (builder, AO distance in metres, triangle budget)
    "orbiter": (build_orbiter, 0.6, 45000),
    "rotorcraft": (build_rotorcraft, 0.07, 45000),
    "lander": (build_lander, 0.3, 40000),
}
NO_AO = ("rotor_disc_upper", "rotor_disc_lower", "lamp_l", "lamp_r",
         "ramp_light")
VIEWS = {
    # azimuth and elevation in degrees, distance factor
    "rotorcraft": [(35, 18, 0.8), (-145, 28, 0.8), (90, 2, 0.8),
                   (20, -22, 0.5), (160, 55, 0.8), (-40, 12, 0.42)],
    "lander": [(35, 22, 0.8), (-140, 30, 0.8), (90, 4, 0.8), (10, 62, 0.8),
               (-20, 10, 0.45)],
    "orbiter": [(40, 25, 0.85), (-140, -25, 0.85), (150, 15, 0.8),
                (25, -35, 0.5), (0, 2, 0.5), (140, 30, 0.4)],
}


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    STACK[:] = [Matrix.Identity(4)]
    GROUPS.clear()
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "OPTIX"
    prefs.get_devices()
    gpu = False
    for dev in prefs.devices:
        dev.use = dev.type == "OPTIX"
        gpu = gpu or dev.use
    sc.cycles.device = "GPU" if gpu else "CPU"
    print("cycles device:", sc.cycles.device)


def finish(origins):
    """Join each group into one object named after the group."""
    dg = bpy.context.evaluated_depsgraph_get()
    objs = []
    for name, parts in GROUPS.items():
        origin = Vector(origins[name])
        bm = bmesh.new()
        mats = []
        for ob in parts:
            me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
            me.transform(ob.matrix_world)
            remap = []
            for m in me.materials:
                if m not in mats:
                    mats.append(m)
                remap.append(mats.index(m))
            n0 = len(bm.faces)
            bm.from_mesh(me)
            bm.faces.ensure_lookup_table()
            new = [bm.faces[i] for i in range(n0, len(bm.faces))]
            for f in new:
                f.material_index = remap[f.material_index]
            if ob.matrix_world.determinant() < 0:
                bmesh.ops.reverse_faces(bm, faces=new)
            bpy.data.meshes.remove(me)
        bmesh.ops.translate(bm, vec=-origin, verts=bm.verts)
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        for m in mats:
            me.materials.append(m)
        ob = bpy.data.objects.new(name, me)
        ob.location = origin
        objs.append(ob)
    for parts in GROUPS.values():
        for ob in parts:
            old = ob.data
            bpy.data.objects.remove(ob)
            bpy.data.meshes.remove(old)
    for ob in objs:
        bpy.context.scene.collection.objects.link(ob)
        mod = ob.modifiers.new("normals", "WEIGHTED_NORMAL")
        mod.keep_sharp = True
        mod.weight = 50
    return objs


def bake_ao(objs, dist):
    """Bake ambient occlusion into a per-corner colour attribute."""
    sc = bpy.context.scene
    if sc.world is None:
        sc.world = bpy.data.worlds.new("world")
    sc.world.light_settings.distance = dist
    sc.cycles.samples = 128
    sc.render.bake.target = "VERTEX_COLORS"
    for ob in objs:
        attr = ob.data.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
        ob.data.color_attributes.active_color = attr
        ob.data.color_attributes.render_color_index = 0
        n = len(attr.data)
        attr.data.foreach_set("color", [1.0] * (4 * n))
        if ob.name.startswith("rotor_disc"):
            ob.hide_render = True
    for ob in objs:
        if ob.name in NO_AO:
            continue
        for o in bpy.context.scene.objects:
            o.select_set(False)
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.bake(type="AO")
        attr = ob.data.color_attributes["Col"]
        n = len(attr.data)
        buf = [0.0] * (4 * n)
        attr.data.foreach_get("color", buf)
        for i in range(n):
            v = min(max(buf[4 * i], 0.0), 1.0)
            v = 0.22 + 0.78 * v ** 1.15
            buf[4 * i:4 * i + 4] = (v, v, v, 1.0)
        attr.data.foreach_set("color", buf)
    for ob in objs:
        ob.hide_render = False


def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def export(objs, path):
    for o in bpy.context.scene.objects:
        o.select_set(False)
    for ob in objs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True,
        export_apply=True, export_yup=True, export_texcoords=False,
        export_normals=True, export_materials="EXPORT",
        export_vertex_color="ACTIVE", export_all_vertex_colors=False,
        export_active_vertex_color_when_no_material=True,
        export_animations=False, export_cameras=False, export_lights=False)


def pack(src, dst):
    subprocess.run(["npx", "-y", "gltfpack@0.25.0", "-i", src, "-o", dst,
                    "-cc", "-kn", "-km"], check=True)


def render_previews(name, objs, outdir):
    """Render the views listed in VIEWS with three sun lights."""
    sc = bpy.context.scene
    # Multiply the baked occlusion into the base colour, as three.js does.
    for m in bpy.data.materials:
        nt = m.node_tree
        bsdf = nt.nodes["Principled BSDF"]
        col = nt.nodes.new("ShaderNodeVertexColor")
        col.layer_name = "Col"
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs[0].default_value = 1.0
        mix.inputs[6].default_value = bsdf.inputs["Base Color"].default_value
        nt.links.new(col.outputs["Color"], mix.inputs[7])
        nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
    lo = Vector((1e9, 1e9, 1e9))
    hi = -lo
    for ob in objs:
        if ob.name.startswith("rotor_disc"):
            ob.hide_render = True
            continue
        for c in ob.bound_box:
            p = ob.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, p))
            hi = Vector(map(max, hi, p))
    centre = (lo + hi) / 2
    radius = (hi - lo).length / 2

    w = bpy.data.worlds.new("preview")
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    mixs = nt.nodes.new("ShaderNodeMixShader")
    lp = nt.nodes.new("ShaderNodeLightPath")
    env = nt.nodes.new("ShaderNodeBackground")
    cam_bg = nt.nodes.new("ShaderNodeBackground")
    cam_bg.inputs["Color"].default_value = (0.028, 0.030, 0.034, 1.0)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs[1].default_value = -1.0
    mr.inputs[2].default_value = 1.0
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    e = ramp.color_ramp.elements
    e[0].position, e[0].color = 0.0, (0.03, 0.03, 0.035, 1)
    e[1].position, e[1].color = 1.0, (1.0, 1.0, 1.0, 1)
    mid = e.new(0.47)
    mid.color = (0.10, 0.10, 0.11, 1)
    mid2 = e.new(0.56)
    mid2.color = (0.55, 0.56, 0.58, 1)
    env.inputs["Strength"].default_value = 0.8
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], mr.inputs[0])
    nt.links.new(mr.outputs[0], ramp.inputs[0])
    nt.links.new(ramp.outputs["Color"], env.inputs["Color"])
    nt.links.new(lp.outputs["Is Camera Ray"], mixs.inputs[0])
    nt.links.new(env.outputs[0], mixs.inputs[1])
    nt.links.new(cam_bg.outputs[0], mixs.inputs[2])
    nt.links.new(mixs.outputs[0], out.inputs[0])
    sc.world = w

    for lname, az, el, power in (("key", 50, 48, 4.0), ("fill", -70, 15, 1.0),
                                 ("rim", 160, 35, 2.5)):
        ld = bpy.data.lights.new(lname, "SUN")
        ld.energy = power
        ld.angle = radians(8)
        lo_ = bpy.data.objects.new(lname, ld)
        a, b_ = radians(az), radians(el)
        dirv = Vector((sin(a) * cos(b_), -cos(a) * cos(b_), sin(b_)))
        lo_.rotation_euler = dirv.to_track_quat("Z", "Y").to_euler()
        sc.collection.objects.link(lo_)
    if name == "lander":
        gm = bpy.data.meshes.new("ground")
        gb = bmesh.new()
        bmesh.ops.create_grid(gb, x_segments=1, y_segments=1, size=30.0)
        gb.to_mesh(gm)
        gb.free()
        mat = bpy.data.materials.new("ground")
        mat.use_nodes = True
        mat.node_tree.nodes["Principled BSDF"].inputs[
            "Base Color"].default_value = (0.012, 0.011, 0.010, 1)
        mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9
        gm.materials.append(mat)
        sc.collection.objects.link(bpy.data.objects.new("ground", gm))

    cd = bpy.data.cameras.new("cam")
    cd.lens = 60
    cd.clip_start = 0.01
    cd.clip_end = 1000
    cam = bpy.data.objects.new("cam", cd)
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.resolution_x = 1400
    sc.render.resolution_y = 1000
    sc.cycles.samples = 96
    sc.cycles.use_denoising = True
    sc.view_settings.view_transform = "Standard"
    sc.render.image_settings.file_format = "PNG"
    os.makedirs(outdir, exist_ok=True)
    for i, (az, el, k) in enumerate(VIEWS[name]):
        a, b_ = radians(az), radians(el)
        dirv = Vector((sin(a) * cos(b_), -cos(a) * cos(b_), sin(b_)))
        dist = k * 0.82 * radius / 0.2096
        cam.location = centre + dirv * dist
        cam.rotation_euler = dirv.to_track_quat("Z", "Y").to_euler()
        sc.render.filepath = os.path.join(outdir, f"{name}_{i}.png")
        bpy.ops.render.render(write_still=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", choices=sorted(BUILDERS))
    ap.add_argument("--preview")
    ap.add_argument("--raw")
    args = ap.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    raw_dir = args.raw or tempfile.mkdtemp(prefix="hero_models_")
    os.makedirs(raw_dir, exist_ok=True)
    for name in ([args.only] if args.only else list(BUILDERS)):
        builder, ao_dist, budget = BUILDERS[name]
        reset_scene()
        origins = builder()
        objs = finish(origins)
        bake_ao(objs, ao_dist)
        total = 0
        for ob in objs:
            t = tri_count(ob)
            total += t
            print(f"  {name}.{ob.name}: {t} triangles, "
                  f"{len(ob.data.materials)} materials")
        print(f"{name}: {total} triangles (budget {budget})")
        if total > budget:
            raise RuntimeError(f"{name} is over its triangle budget")
        raw = os.path.join(raw_dir, f"{name}.glb")
        export(objs, raw)
        dst = os.path.join(args.out, f"{name}.glb")
        pack(raw, dst)
        print(f"{name}: wrote {dst} ({os.path.getsize(dst) / 1024:.0f} KB)")
        if args.preview:
            render_previews(name, objs, args.preview)
    if not args.raw:
        shutil.rmtree(raw_dir)


if __name__ == "__main__":
    main()
