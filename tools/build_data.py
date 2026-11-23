#!/usr/bin/env python3
"""Build the web assets of the interactive hero from the released survey data.

Run with the analysis environment:

    ../lavatube_maps_data_analysis/.venv/bin/python tools/build_data.py [terrain] [tube] [cloud] [meta]

With no stage named, all four run in order. Inputs are read from
../lavatube_maps_data_analysis (maps/ and analysis_out_v9/); nothing is
written there. Outputs go to public/hero/ and intermediates to tools/.cache/.

Frames. The survey frame is the local ISN2016 frame of the analysis (x east,
y north, z orthometric height, metres). The scene frame is right-handed with
y up:  X = x - X0,  Y = z - Z0,  Z = -(y - Y0).

What is measured and what is not. The near terrain tile, the tube mesh, the
interior point cloud, the centreline, the overburden and the skylight
ellipses are the survey. The far terrain, the craters, the flight path and
the first-seen times of the points are generated here, and meta.json says so.
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

HERE = Path(__file__).resolve().parent
SITE = HERE.parent
ANA = SITE.parent / "lavatube_maps_data_analysis"
OUT = SITE / "public" / "hero"
CACHE = HERE / ".cache"
OUT.mkdir(parents=True, exist_ok=True)
CACHE.mkdir(parents=True, exist_ok=True)

X0, Y0, Z0 = 1360.7, 691.0, 170.0
RES = 0.5  # near tile, metres
FAR_RES = 4.0
FAR_N = 1024
# Sun, scene frame: 24 degrees above the horizon.
SUN_EL = np.radians(24.0)
SUN_AZ = np.radians(212.0)  # measured from +X toward +Z
SUN = np.array([np.cos(SUN_EL) * np.cos(SUN_AZ), np.sin(SUN_EL), np.cos(SUN_EL) * np.sin(SUN_AZ)])
RNG = np.random.default_rng(20261123)


def to_scene(p: np.ndarray) -> np.ndarray:
    p = np.asarray(p, dtype=np.float64)
    return np.stack([p[..., 0] - X0, p[..., 2] - Z0, -(p[..., 1] - Y0)], axis=-1)


def load_dem():
    d = np.load(ANA / "analysis_out_v9" / "dem_grid_aerial_isn16_ortho_dem.npz")
    z = d["z"].astype(np.float64)  # z[ix, iy]
    return z, float(d["xmin"]), float(d["ymin"]), float(d["res"])


def csv(path):
    return np.genfromtxt(path, delimiter=",", names=True, dtype=None, encoding="utf-8")


def fill_nearest(a: np.ndarray, bad: np.ndarray) -> np.ndarray:
    idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
    return a[tuple(idx)]


def fbm(n: int, beta: float, seed: int) -> np.ndarray:
    """Random field with a power-law spectrum, zero mean, unit standard deviation."""
    rng = np.random.default_rng(seed)
    f = np.fft.fftfreq(n)
    k = np.hypot(*np.meshgrid(f, f, indexing="ij"))
    k[0, 0] = 1.0
    amp = k ** (-beta / 2.0)
    amp[0, 0] = 0.0
    spec = amp * np.exp(2j * np.pi * rng.random((n, n)))
    a = np.fft.ifft2(spec).real
    return (a - a.mean()) / a.std()


def shadow_bake(h: np.ndarray, res: float, reach: float) -> np.ndarray:
    """Fraction of direct sun on a height grid h[j, i] (j along scene Z, i along scene X)."""
    dx, dz = SUN[0], SUN[2]
    hl = np.hypot(dx, dz)
    ux, uz = dx / hl, dz / hl
    slope = SUN[1] / hl
    jj, ii = np.meshgrid(np.arange(h.shape[0]), np.arange(h.shape[1]), indexing="ij")
    lit = np.ones_like(h)
    step = res
    for k in range(1, int(reach / step)):
        d = k * step
        s = ndimage.map_coordinates(h, [jj + uz * d / res, ii + ux * d / res], order=1, mode="nearest")
        clear = (h + slope * d) - s  # positive when the ray passes above the terrain
        lit = np.minimum(lit, np.clip(clear / (0.06 * d + 0.05) + 0.5, 0.0, 1.0))
    return lit


# --------------------------------------------------------------------------- terrain


def stage_terrain():
    from PIL import Image
    import open3d as o3d

    z, xmin, ymin, res = load_dem()
    nx, ny = z.shape
    bad = ~np.isfinite(z)
    zf = fill_nearest(z, bad)

    # Skylight openings: cells well below the closed surface, near a detected opening.
    holes = json.load(open(ANA / "analysis_out_v9" / "aerial_holes.json"))["holes"]
    env = ndimage.grey_closing(zf, size=(41, 41))
    xs = xmin + np.arange(nx) * res
    ys = ymin + np.arange(ny) * res
    XX, YY = np.meshgrid(xs, ys, indexing="ij")
    near_hole = np.zeros_like(bad)
    for hdef in holes[:3]:
        cx, cy = hdef["centroid"][:2]
        near_hole |= np.hypot(XX - cx, YY - cy) < 1.5 * hdef["semi_major"] + 2.0
    opening = near_hole & ((env - zf > 1.5) | bad)
    opening = ndimage.binary_opening(opening, iterations=1)

    # The visitor building and car park by the entrance are not terrain: open the
    # surface morphologically there (removes the building box) and smooth it.
    site = ((XX > 1392) & (XX < 1494) & (YY < 575)) | ((XX > 1320) & (XX < 1494) & (YY < 520))
    flat = ndimage.gaussian_filter(ndimage.grey_opening(zf, size=(37, 37)), 3.0)
    wsite = np.clip(ndimage.gaussian_filter(site.astype(np.float64), 8.0) * 1.5, 0, 1)
    zf = zf * (1 - wsite) + flat * wsite

    # The road embankment is not terrain either. Away from where the tube passes
    # under it, interpolate the ground across the road band from both sides.
    cl = csv(ANA / "analysis_out_v9" / "centreline.csv")
    dcl = cKDTree(np.c_[cl["x"], cl["y"]]).query(np.c_[XX.ravel(), YY.ravel()])[0].reshape(XX.shape)
    rm = road_mask(xmin, ymin, res, nx, ny)
    keepw = (~rm).astype(np.float64)
    interp = ndimage.gaussian_filter(zf * keepw, 12.0) / np.maximum(ndimage.gaussian_filter(keepw, 12.0), 1e-3)
    interp += 0.22 * ndimage.zoom(fbm(256, 2.6, 51), (nx / 256, ny / 256), order=1)[:nx, :ny]
    wroad = np.clip(ndimage.gaussian_filter(rm.astype(np.float64), 5.0) * 1.6, 0, 1) * np.clip((dcl - 22.0) / 25.0, 0, 1)
    zf = zf * (1 - wroad) + interp * wroad

    # Scene-ordered arrays: row j along scene Z (north to south), column i along scene X.
    def scene_grid(a):
        return np.ascontiguousarray(a[:, ::-1].T)

    H = scene_grid(zf) - Z0
    OPEN = scene_grid(opening)
    hmin, hmax = float(H.min()) - 0.5, float(H.max()) + 0.5
    q = np.round((H - hmin) / (hmax - hmin) * 65535).astype("<u2")
    q.tofile(OUT / "terrain_near.u16")
    np.save(CACHE / "near_h.npy", H)
    np.save(CACHE / "near_open.npy", OPEN)

    # Far field: the fitted regional plane plus generated relief, blended into the survey.
    A = np.c_[XX.ravel() - X0, YY.ravel() - Y0, np.ones(XX.size)]
    coef, *_ = np.linalg.lstsq(A[~bad.ravel()], zf.ravel()[~bad.ravel()] - Z0, rcond=None)
    resid = (zf - Z0) - (A @ coef).reshape(zf.shape)
    rough = float(resid[~bad].std())
    half = FAR_N * FAR_RES / 2
    fx = -half + (np.arange(FAR_N) + 0.5) * FAR_RES  # scene X
    fz = -half + (np.arange(FAR_N) + 0.5) * FAR_RES  # scene Z
    FX, FZ = np.meshgrid(fx, fz)  # [j, i]
    plane = coef[0] * FX + coef[1] * (-FZ) + coef[2]
    # Keep the regional slope gentle away from the site so the horizon stays level.
    r = np.hypot(FX, FZ)
    plane *= np.clip(1.0 - (r - 300.0) / 1500.0, 0.25, 1.0)
    relief = 9.0 * fbm(FAR_N, 3.2, 11) + 2.4 * fbm(FAR_N, 2.4, 12) + 0.6 * np.abs(fbm(FAR_N, 2.0, 13))
    relief *= rough / 2.0 if rough > 0 else 1.0
    far = plane + relief
    # Subdued craters outside the survey.
    craters = []
    for _ in range(26):
        for _try in range(50):
            cx, cz = RNG.uniform(-half * 0.92, half * 0.92, 2)
            if np.hypot(cx, cz) > 420.0:
                break
        rad = float(np.exp(RNG.uniform(np.log(14.0), np.log(150.0))))
        d = np.hypot(FX - cx, FZ - cz) / rad
        depth = 0.16 * rad * RNG.uniform(0.5, 1.0)
        bowl = np.where(d < 1.0, -depth * (1.0 - d**2), 0.0)
        rim = 0.25 * depth * np.exp(-((d - 1.0) / 0.28) ** 2)
        far += bowl + rim
        craters.append([float(cx), float(cz), rad])
    # Blend: inside the survey tile the far grid is the block-averaged survey.
    x_lo, x_hi = xmin - X0, xmin - X0 + (nx - 1) * res
    z_lo, z_hi = -(ymin + (ny - 1) * res - Y0), -(ymin - Y0)
    ii = (FX - x_lo) / res
    jj = (FZ - z_lo) / res
    Hs = ndimage.uniform_filter(H, size=int(FAR_RES / res))
    samp = ndimage.map_coordinates(Hs, [np.clip(jj, 0, H.shape[0] - 1), np.clip(ii, 0, H.shape[1] - 1)], order=1)
    dout = np.hypot(np.maximum(np.maximum(x_lo - FX, FX - x_hi), 0), np.maximum(np.maximum(z_lo - FZ, FZ - z_hi), 0))
    w = np.clip(dout / 90.0, 0, 1)
    w = w * w * (3 - 2 * w)
    far = samp * (1 - w) + far * w
    fmin, fmax = float(far.min()) - 0.5, float(far.max()) + 0.5
    np.round((far - fmin) / (fmax - fmin) * 65535).astype("<u2").tofile(OUT / "terrain_far.u16")
    np.save(CACHE / "far_h.npy", far)

    # Sun: baked direct-light fraction for both grids.
    lit_near = shadow_bake(np.where(OPEN, H - 12.0, H), res, 70.0)
    lit_far = shadow_bake(far, FAR_RES, 600.0)
    Image.fromarray((lit_far * 255).astype(np.uint8)).save(OUT / "terrain_far_light.png", optimize=True)

    # Orthomosaic detail: luminance and a dust index from the survey colours.
    t = 0.16
    tw, th = int(np.ceil((nx - 1) * res / t)), int(np.ceil((ny - 1) * res / t))
    cache = CACHE / "ortho.npz"
    if cache.exists():
        d = np.load(cache)
        lum, grn, cnt = d["lum"], d["grn"], d["cnt"]
    else:
        pc = o3d.t.io.read_point_cloud(str(ANA / "maps" / "aerial_isn16_ortho_surface_10cm.pcd"))
        P = pc.point.positions.numpy()
        C = pc.point.colors.numpy().astype(np.float32)
        ix = np.floor((P[:, 0] - xmin) / t).astype(np.int64)
        iy = np.floor((P[:, 1] - ymin) / t).astype(np.int64)
        ok = (ix >= 0) & (ix < tw) & (iy >= 0) & (iy < th)
        flat = (ix[ok] * th + iy[ok])
        cnt = np.bincount(flat, minlength=tw * th).astype(np.float32)
        l = 0.299 * C[ok, 0] + 0.587 * C[ok, 1] + 0.114 * C[ok, 2]
        g = C[ok, 1] - 0.5 * (C[ok, 0] + C[ok, 2])
        lum = np.bincount(flat, weights=l, minlength=tw * th).astype(np.float32)
        grn = np.bincount(flat, weights=g, minlength=tw * th).astype(np.float32)
        np.savez(cache, lum=lum, grn=grn, cnt=cnt)
    cnt2 = cnt.reshape(tw, th)
    empty = cnt2 == 0
    lum2 = np.where(empty, 0, lum.reshape(tw, th) / np.maximum(cnt2, 1))
    grn2 = np.where(empty, 0, grn.reshape(tw, th) / np.maximum(cnt2, 1))
    lum2 = fill_nearest(lum2, empty)
    grn2 = fill_nearest(grn2, empty)

    # A seamless patch of natural ground from the survey (82 m square). It covers
    # the road, the building and the car park here, and the shader tiles it over
    # the far terrain.
    tn = 512
    i0, j0 = int((1400.0 - xmin) / t), int((760.0 - ymin) / t)
    def seamless(a):
        a = a[i0:i0 + tn, j0:j0 + tn].astype(np.float64)
        w1 = 0.5 - 0.5 * np.cos(2 * np.pi * (np.arange(tn) + 0.5) / tn)
        w = np.outer(w1, w1) ** 0.5
        b_ = np.roll(a, (tn // 2, tn // 2), axis=(0, 1))
        m = a.mean()
        out = m + ((a - m) * w + (b_ - m) * (1 - w)) / np.sqrt(w**2 + (1 - w) ** 2)
        return out
    tile_l, tile_g = seamless(lum2), seamless(grn2)
    man = road_mask(xmin, ymin, t, tw, th)
    txs = xmin + (np.arange(tw) + 0.5) * t
    tys = ymin + (np.arange(th) + 0.5) * t
    TX, TY = np.meshgrid(txs, tys, indexing="ij")
    man |= ((TX > 1400) & (TY < 625)) | ((TX > 1392) & (TY < 575)) | ((TX > 1320) & (TY < 520))
    ii_, jj_ = np.meshgrid(np.arange(tw), np.arange(th), indexing="ij")
    # Two copies of the patch, one turned a quarter and shifted, mixed by a slow noise, so the repeat does not show.
    mixn = np.clip(0.5 + 0.9 * ndimage.zoom(fbm(256, 3.0, 41), (tw / 256, th / 256), order=1)[:tw, :th], 0, 1)
    pl = tile_l[ii_ % tn, jj_ % tn] * mixn + tile_l[(jj_ + 211) % tn, (ii_ + 97) % tn] * (1 - mixn)
    pg = tile_g[ii_ % tn, jj_ % tn] * mixn + tile_g[(jj_ + 211) % tn, (ii_ + 97) % tn] * (1 - mixn)
    soft = np.clip(ndimage.gaussian_filter(man.astype(np.float32), 5.0) * 2.0, 0, 1)
    lum2 = lum2 * (1 - soft) + pl * soft
    grn2 = grn2 * (1 - soft) + pg * soft

    def norm(a, lo, hi):
        p0, p1 = np.percentile(a, [lo, hi])
        return np.clip((a - p0) / (p1 - p0), 0, 1)

    L8 = (norm(lum2, 0.5, 99.5) * 255).astype(np.uint8)
    G8 = (norm(ndimage.gaussian_filter(grn2, 1.0), 2, 98) * 255).astype(np.uint8)
    jt, it = np.meshgrid(np.arange(th), np.arange(tw), indexing="ij")
    lit_t = ndimage.map_coordinates(lit_near, [(th - 1 - jt) * 0 + jt * (H.shape[0] - 1) / (th - 1), it * (H.shape[1] - 1) / (tw - 1)], order=1)
    rgb = np.stack([scene_grid(L8), scene_grid(G8), (lit_t * 255).astype(np.uint8)], axis=-1)
    Image.fromarray(rgb).save(OUT / "terrain_near_detail.jpg", quality=86, optimize=True)
    lo_l, hi_l = np.percentile(lum2, [0.5, 99.5])
    gs = ndimage.gaussian_filter(grn2, 1.0)
    lo_g, hi_g = np.percentile(gs, [2, 98])
    tile = np.stack([np.clip((tile_l - lo_l) / (hi_l - lo_l), 0, 1), np.clip((ndimage.gaussian_filter(tile_g, 1.0, mode="wrap") - lo_g) / (hi_g - lo_g), 0, 1),
                     np.ones_like(tile_l)], axis=-1)
    Image.fromarray((tile * 255).astype(np.uint8)).save(OUT / "ground_tile.jpg", quality=88, optimize=True)

    meta = {
        "near": {"nx": int(H.shape[1]), "nz": int(H.shape[0]), "res": res, "x0": x_lo, "z0": z_lo, "hmin": hmin, "hmax": hmax},
        "far": {"n": FAR_N, "res": FAR_RES, "x0": -half + FAR_RES / 2, "z0": -half + FAR_RES / 2, "hmin": fmin, "hmax": fmax},
        "sun": SUN.tolist(),
        "craters": craters,
        "plane_roughness_m": rough,
        "tile": {"size_m": 512 * 0.16},
    }
    json.dump(meta, open(CACHE / "terrain_meta.json", "w"))
    Image.fromarray((OPEN * 255).astype(np.uint8)).save(OUT / "terrain_near_open.png", optimize=True)
    print(f"terrain: near {H.shape}, heights {hmin:.1f}..{hmax:.1f} m, openings {int(OPEN.sum())} cells, "
          f"far {far.shape} {fmin:.1f}..{fmax:.1f} m, roughness {rough:.2f} m, detail {rgb.shape}")


def road_mask(xmin, ymin, t, tw, th):
    # Same projection as analysis/road_crossing.py: the local frame is UTM 27N minus the origin.
    from pyproj import Transformer
    d = json.load(open(ANA / "analysis_out_v9" / "osm_way_620673065.json"))
    nodes = {e["id"]: (e["lon"], e["lat"]) for e in d["elements"] if e["type"] == "node"}
    way = next(e for e in d["elements"] if e["type"] == "way")
    tr = Transformer.from_crs(4326, 32627, always_xy=True)
    origin = json.load(open(ANA / "analysis_out_v9" / "aerial_holes.json"))["origin"]
    xy = np.array([tr.transform(*nodes[i]) for i in way["nodes"]])
    px = xy[:, 0] - origin[0]
    py = xy[:, 1] - origin[1]
    # Densify the polyline and stamp discs of 7.5 m radius.
    pts = []
    for a in range(len(px) - 1):
        n = max(2, int(np.hypot(px[a + 1] - px[a], py[a + 1] - py[a]) / 0.5))
        s = np.linspace(0, 1, n, endpoint=False)
        pts.append(np.c_[px[a] + s * (px[a + 1] - px[a]), py[a] + s * (py[a + 1] - py[a])])
    pts = np.vstack(pts)
    m = np.zeros((tw, th), bool)
    ix = np.round((pts[:, 0] - xmin) / t).astype(int)
    iy = np.round((pts[:, 1] - ymin) / t).astype(int)
    ok = (ix >= 0) & (ix < tw) & (iy >= 0) & (iy < th)
    m[ix[ok], iy[ok]] = True
    return ndimage.binary_dilation(m, iterations=int(15.0 / t)) if m.any() else m


# --------------------------------------------------------------------------- tube


def clean_interior():
    """The interior cloud of the first long flight, cut to the tube and its shafts.

    The drawn geometry uses the map built on board during the flight
    (tube_10cm_ed_ortho.pcd). The offline map the paper's numbers come from
    (flf_10cm_ed_ortho.pcd) agrees with it to 0.2 m at 99% of points but also
    holds second copies of the walls, up to 3 m off, where the outbound and
    return passes were not closed; a surface fitted to it has walls inside
    the void.
    """
    import open3d as o3d

    cache = CACHE / "interior_onboard.npz"
    if cache.exists():
        d = np.load(cache)
        return d["P"], d["N"], d["I"], d["K"]
    pc = o3d.t.io.read_point_cloud(str(ANA / "maps" / "tube_10cm_ed_ortho.pcd"))
    P = pc.point.positions.numpy().astype(np.float64)
    I = pc.point.intensity.numpy().ravel().astype(np.float64)
    # Stray returns in the void (dust, the airframe): fewer than six neighbours within 0.3 m.
    dense = cKDTree(P).query_ball_point(P, 0.3, return_length=True, workers=-1) >= 7
    print(f"interior: dropped {int((~dense).sum()):,} stray returns of {len(P):,}")
    P, I = P[dense], I[dense]
    leg = o3d.geometry.PointCloud()
    leg.points = o3d.utility.Vector3dVector(P)
    leg.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=0.4, max_nn=30))
    N = np.asarray(leg.normals).copy()
    cl = csv(ANA / "analysis_out_v9" / "centreline.csv")
    mo = csv(ANA / "analysis_out_v9" / "morphometry.csv")
    C = np.c_[cl["x"], cl["y"], cl["z"]]
    T = np.c_[cl["tx"], cl["ty"], cl["tz"]]
    hw = np.maximum(ndimage.maximum_filter1d(np.nan_to_num(mo["width"], nan=10.0), 7) / 2 + 2.5, 7.0)
    zf = ndimage.minimum_filter1d(np.nan_to_num(mo["z_floor"], nan=160.0), 7)
    k = cKDTree(C[:, :2]).query(P[:, :2])[1]
    dh = np.hypot(P[:, 0] - C[k, 0], P[:, 1] - C[k, 1])
    along = np.einsum("ij,ij->i", P - C[k], T[k])
    z, xmin, ymin, res = load_dem()
    zs = fill_nearest(z, ~np.isfinite(z))
    env = ndimage.grey_closing(zs, size=(41, 41))
    gi = np.clip((P[:, 0] - xmin) / res, 0, z.shape[0] - 1)
    gj = np.clip((P[:, 1] - ymin) / res, 0, z.shape[1] - 1)
    surf = ndimage.map_coordinates(env, [gi, gj], order=1)
    keep = (dh <= hw[k]) & (P[:, 2] >= zf[k] - 3.0) & (P[:, 2] <= surf + 0.4)
    ends = ((k == 0) & (along < -6.0)) | ((k == len(C) - 1) & (along > 6.0))
    keep &= ~ends
    P, N, I, k = P[keep], N[keep], I[keep], k[keep]
    # Normals toward the centreline.
    flip = np.einsum("ij,ij->i", N, C[k] - P) < 0
    N[flip] *= -1
    np.savez(cache, P=P, N=N, I=I, K=k)
    print(f"interior: kept {len(P):,} of {len(keep):,} points")
    return P, N, I, k


FULL_VOX = 0.035


def interior_full():
    """The interior at full resolution: positions, normals (into the void) and intensity at 3.5 cm.

    The map built on board during the first long flight has 154 million
    returns (first_long_flight_full.pcd, in the frame the robot built it in);
    tube_10cm.pcd is its 10 cm copy. The returns are moved into the survey
    frame with the rigid transform that carries that 10 cm copy onto the
    registered one, kept if they lie within 12 cm of the cleaned 10 cm map
    (which drops strays and what lies outside the tube), and averaged in
    3.5 cm cells.
    """
    import open3d as o3d

    cache = CACHE / "interior_full.npz"
    if cache.exists():
        d = np.load(cache)
        return d["P"], d["N"], d["I"]
    Pm = clean_interior()[0]
    a = o3d.t.io.read_point_cloud(str(ANA / "maps" / "tube_10cm.pcd")).point.positions.numpy().astype(np.float64)
    b_ = o3d.t.io.read_point_cloud(str(ANA / "maps" / "tube_10cm_ed_ortho.pcd")).point.positions.numpy().astype(np.float64)
    ca, cb = a.mean(0), b_.mean(0)
    U, _, Vt = np.linalg.svd((a - ca).T @ (b_ - cb))
    R = Vt.T @ U.T
    t = cb - R @ ca
    resid = np.linalg.norm(a @ R.T + t - b_, axis=1).max()
    assert resid < 1e-3, f"the two 10 cm copies are not one rigid motion apart ({resid:.3f} m)"
    path = ANA / "maps" / "first_long_flight_full.pcd"
    with open(path, "rb") as f:
        head = b""
        while not head.endswith(b"DATA binary\n"):
            head += f.read(1)
        offset = f.tell()
    n = int([l for l in head.decode().splitlines() if l.startswith("POINTS")][0].split()[1])
    raw = np.memmap(path, dtype="<f4", mode="r", offset=offset, shape=(n, 4))
    tree = cKDTree(Pm)
    lo, hi = Pm.min(0) - 0.2, Pm.max(0) + 0.2
    keys, sums, cnts = [], [], []
    kept = 0
    for i0 in range(0, n, 8_000_000):
        blk = np.asarray(raw[i0:i0 + 8_000_000], dtype=np.float64)
        ok = np.isfinite(blk).all(1)
        X = blk[ok, :3] @ R.T + t
        inb = ((X >= lo) & (X <= hi)).all(1)
        X, inten = X[inb], blk[ok, 3][inb]
        near = np.isfinite(tree.query(X, distance_upper_bound=0.12, workers=-1)[0])
        X, inten = X[near], inten[near]
        kept += len(X)
        # Average inside the block first, so the per-block arrays stay small.
        q = np.floor((X - lo) / FULL_VOX).astype(np.int64)
        key = (q[:, 0] << 42) | (q[:, 1] << 21) | q[:, 2]
        u, inv, c = np.unique(key, return_inverse=True, return_counts=True)
        sm = np.zeros((len(u), 4))
        for k in range(3):
            sm[:, k] = np.bincount(inv, weights=X[:, k], minlength=len(u))
        sm[:, 3] = np.bincount(inv, weights=inten, minlength=len(u))
        keys.append(u)
        sums.append(sm)
        cnts.append(c)
        print(f"  full cloud: {min(i0 + 8_000_000, n) / 1e6:.0f} of {n / 1e6:.0f} million read, {kept / 1e6:.1f} million kept", flush=True)
    key = np.concatenate(keys)
    sm = np.vstack(sums)
    c = np.concatenate(cnts)
    u, inv = np.unique(key, return_inverse=True)
    S = np.zeros((len(u), 4))
    for k in range(4):
        S[:, k] = np.bincount(inv, weights=sm[:, k], minlength=len(u))
    C_ = np.bincount(inv, weights=c, minlength=len(u))
    # A cell with a single return is as likely noise as rock.
    good = C_ >= 2
    P = S[good, :3] / C_[good, None]
    I = S[good, 3] / C_[good]
    pc = o3d.geometry.PointCloud()
    pc.points = o3d.utility.Vector3dVector(P)
    pc.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=0.14, max_nn=24))
    N = toward_void(P, np.asarray(pc.normals))
    np.savez(cache, P=P, N=N, I=I)
    print(f"interior at full resolution: {kept / 1e6:.1f} million returns kept of {n / 1e6:.0f} million, {len(P) / 1e6:.2f} million cells of {FULL_VOX * 100:.1f} cm")
    return P, N, I


def write_glb(path: Path, V: np.ndarray, Nn: np.ndarray, Col: np.ndarray, F: np.ndarray):
    """Minimal binary glTF: one mesh with POSITION, NORMAL, COLOR_0 (RGBA8) and uint32 indices."""
    V = V.astype("<f4")
    Nn = Nn.astype("<f4")
    Col = Col.astype(np.uint8)
    F = F.astype("<u4")
    chunks = [V.tobytes(), Nn.tobytes(), Col.tobytes(), F.tobytes()]
    views, off = [], 0
    for c, target in zip(chunks, [34962, 34962, 34962, 34963]):
        views.append({"buffer": 0, "byteOffset": off, "byteLength": len(c), "target": target})
        off += len(c) + (-len(c)) % 4
    blob = b"".join(c + b"\0" * ((-len(c)) % 4) for c in chunks)
    gltf = {
        "asset": {"version": "2.0", "generator": "lavatube-survey build_data.py"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "tube"}],
        "meshes": [{"name": "tube", "primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2}, "indices": 3}]}],
        "buffers": [{"byteLength": len(blob)}],
        "bufferViews": views,
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(V), "type": "VEC3", "min": V.min(0).tolist(), "max": V.max(0).tolist()},
            {"bufferView": 1, "componentType": 5126, "count": len(V), "type": "VEC3"},
            {"bufferView": 2, "componentType": 5121, "normalized": True, "count": len(V), "type": "VEC4"},
            {"bufferView": 3, "componentType": 5125, "count": F.size, "type": "SCALAR"},
        ],
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((-len(js)) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack("<II", len(blob), 0x004E4942))
        f.write(blob)


def sphere_dirs(n: int) -> np.ndarray:
    i = np.arange(n) + 0.5
    phi = np.arccos(1 - 2 * i / n)
    th = np.pi * (1 + 5**0.5) * i
    return np.c_[np.cos(th) * np.sin(phi), np.sin(th) * np.sin(phi), np.cos(phi)]


def toward_void(P, N):
    """Normals turned to point into the void: toward the nearest point of the flown line, which is free space.

    The centroid of a cross-section will not do: under a skylight the rubble cone rises above it.
    """
    ft, fp, _, legs, _, _ = build_flight()
    t0 = dict((n, a) for n, a, b in legs)["descent"]
    t1 = dict((n, b) for n, a, b in legs)["ascent"]
    line = fp[(ft >= t0) & (ft <= t1)]
    near = line[cKDTree(line).query(P, workers=-1)[1]]
    flip = np.einsum("ij,ij->i", N, near - P) < 0
    N = N.copy()
    N[flip] *= -1
    return N


TUBE_DEPTH = 12  # Poisson cells of 7.5 cm over the 300 m of tube
TUBE_TRIANGLES = 3_200_000


def stage_tube():
    """The rock surface of the tube, fitted to the interior cloud, at two resolutions.

    tube_hi (the Poisson surface at 7.5 cm on the full-resolution cloud,
    reduced to TUBE_TRIANGLES) is what the page draws once it has arrived;
    tube (300,000 triangles) is in the first download and serves small
    devices. Vertex colours carry ambient occlusion, sky visibility, direct
    sun and the lidar intensity averaged over the nearest returns.
    """
    import open3d as o3d

    P, N, I = interior_full()
    pc = o3d.geometry.PointCloud()
    pc.points = o3d.utility.Vector3dVector(P)
    pc.normals = o3d.utility.Vector3dVector(-N)  # Poisson wants outward normals of the solid rock side
    mesh, dens = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(pc, depth=TUBE_DEPTH, scale=1.05, linear_fit=True)
    dens = np.asarray(dens)
    mesh.remove_vertices_by_mask(dens < np.quantile(dens, 0.012))
    # Keep the surface Poisson closes over gaps in the lidar coverage (the floor
    # behind breakdown blocks), but drop what it invents far from any measured
    # point and anything above the ground surface, so the skylights stay open.
    V = np.asarray(mesh.vertices)
    ptree = cKDTree(P)
    d = ptree.query(V, workers=-1)[0]
    # The top of the rock is the ground the page draws: the near tile where it is closed, and across an
    # opening the lowest ground within 3 m of it, so no rock stands above the ground at a rim.
    z, xmin, ymin, res = load_dem()
    ground = np.load(CACHE / "near_h.npy").T[:, ::-1] + Z0  # back from scene order to [ix, iy]
    opening = ndimage.binary_dilation(np.load(CACHE / "near_open.npy").T[:, ::-1], iterations=2)
    rim = ndimage.minimum_filter(np.where(opening, 1e3, ground), size=13)
    top = np.minimum(np.where(opening, rim, ground), ndimage.minimum_filter(np.where(opening, rim, ground), size=3))
    gi = np.clip((V[:, 0] - xmin) / res, 0, z.shape[0] - 1)
    gj = np.clip((V[:, 1] - ymin) / res, 0, z.shape[1] - 1)
    surf = ndimage.map_coordinates(top, [gi, gj], order=1)
    mesh.remove_vertices_by_mask((d > 1.6) | (V[:, 2] > surf - 0.12))
    # One shell: islands floating in the void or in the rock are not the tube.
    tri_c, tri_n, _ = mesh.cluster_connected_triangles()
    tri_c, tri_n = np.asarray(tri_c), np.asarray(tri_n)
    mesh.remove_triangles_by_mask(tri_n[tri_c] < 0.02 * tri_n.max())
    mesh.remove_unreferenced_vertices()
    print(f"tube mesh as fitted: {len(mesh.triangles):,} triangles")
    if len(mesh.triangles) > TUBE_TRIANGLES * 1.05:
        mesh = mesh.simplify_quadric_decimation(target_number_of_triangles=TUBE_TRIANGLES)
        mesh.remove_degenerate_triangles()
        mesh.remove_unreferenced_vertices()
    cl = csv(ANA / "analysis_out_v9" / "centreline.csv")
    C = np.c_[cl["x"], cl["y"], cl["z"]]
    holes = json.load(open(ANA / "analysis_out_v9" / "aerial_holes.json"))["holes"][:3]
    # Daylight enters by the three skylights only: the walk-in entrance of the real cave has no opening in the concept scene.
    cen = np.array([h["centroid"][:2] for h in holes])

    def oriented(mesh):
        """Vertices, faces and normals with normals and winding toward the void."""
        mesh.compute_vertex_normals()
        V = np.asarray(mesh.vertices)
        F = np.asarray(mesh.triangles)
        Nn = np.asarray(mesh.vertex_normals).copy()
        if np.median(np.einsum("ij,ij->i", Nn, toward_void(V, Nn))) < 0:
            F = F[:, ::-1].copy()
            Nn = -Nn
        return V, F, Nn

    def write(name, V, F, Nn, Col):
        Vs = to_scene(V)
        Ns = np.stack([Nn[:, 0], Nn[:, 2], -Nn[:, 1]], axis=-1)
        write_glb(CACHE / name, Vs, Ns, np.clip(np.round(Col * 255), 0, 255).astype(np.uint8), F[:, ::-1])  # the frame change mirrors handedness

    V, F, Nn = oriented(mesh)
    np.savez(CACHE / "tube_mesh.npz", V=V, F=F, N=Nn)

    # Bakes: ambient occlusion, sky visibility and direct sun, by ray casting.
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(V.astype(np.float32)), o3d.core.Tensor(F.astype(np.uint32)))
    org = (V + Nn * 0.06).astype(np.float32)
    dirs = sphere_dirs(96)
    ao = np.zeros(len(V))
    sky = np.zeros(len(V))
    wsum = np.zeros(len(V))
    ssum = np.zeros(len(V))
    for dvec in dirs:
        cosn = Nn @ dvec
        use = cosn > 0.05
        rays = np.c_[org[use], np.broadcast_to(dvec.astype(np.float32), (use.sum(), 3))]
        t = scene.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy()
        w = cosn[use]
        ao[use] += w * np.clip(t / 3.5, 0, 1)
        wsum[use] += w
        if dvec[2] > 0.25:
            sky[use] += np.isinf(t) * dvec[2]
            ssum[use] += dvec[2]
    ao = ao / np.maximum(wsum, 1e-6)
    sky = sky / np.maximum(ssum, 1e-6)
    sun_survey = np.array([SUN[0], -SUN[2], SUN[1]], dtype=np.float32)
    rays = np.c_[org, np.broadcast_to(sun_survey, (len(V), 3))]
    sun = np.isinf(scene.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy()) & (Nn @ sun_survey > 0)
    # Daylight only counts near an opening; elsewhere a gap in the mesh is not a skylight.
    dopen = np.min(np.hypot(V[:, None, 0] - cen[None, :, 0], V[:, None, 1] - cen[None, :, 1]), axis=1)
    win = np.clip(1.0 - (dopen - 14.0) / 16.0, 0, 1)
    sky *= win
    sun = sun & (dopen < 14.0)
    # Lidar intensity: noisy from return to return, so average the nearest returns; it reads as rock texture.
    Iv = I[ptree.query(V, k=12, workers=-1)[1]].mean(1)
    p2, p98 = np.percentile(Iv, [2, 98])
    Iv = np.clip((Iv - p2) / (p98 - p2), 0, 1)
    # Smooth the bakes over the mesh once.
    adj = np.r_[F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]
    def smooth(a, it=2):
        a = a.astype(np.float64)
        for _ in range(it):
            s = np.bincount(adj[:, 0], weights=a[adj[:, 1]], minlength=len(a)) + np.bincount(adj[:, 1], weights=a[adj[:, 0]], minlength=len(a))
            n = np.bincount(adj[:, 0], minlength=len(a)) + np.bincount(adj[:, 1], minlength=len(a))
            a = 0.5 * a + 0.5 * s / np.maximum(n, 1)
        return a
    ao, sky, sunf, Iv = smooth(ao), smooth(sky), smooth(sun, 1), smooth(Iv, 1)
    Col = np.stack([ao, sky, sunf, Iv], axis=-1)
    write("tube_hi_raw.glb", V, F, Nn, Col)
    print(f"tube_hi: {len(V):,} vertices, {len(F):,} triangles; ao mean {ao.mean():.2f}, sky>0.05 at {np.mean(sky > 0.05) * 100:.1f}% of vertices, sun on {sun.mean() * 100:.2f}%")

    # The light mesh takes its colours from the nearest vertex of the full one.
    lite = mesh.simplify_quadric_decimation(target_number_of_triangles=300_000)
    lite.remove_degenerate_triangles()
    lite.remove_unreferenced_vertices()
    Vl, Fl, Nl = oriented(lite)
    write("tube_raw.glb", Vl, Fl, Nl, Col[cKDTree(V).query(Vl, workers=-1)[1]])
    print(f"tube: {len(Vl):,} vertices, {len(Fl):,} triangles")


# --------------------------------------------------------------------------- flight and cloud

G_MARS = 3.71
CUT_N = 0.42  # where the section is cut, as a fraction of the half width, on the +side of the tube
FLIGHT_HZ = 5.0


def smooth1d(a, win):
    k = np.hanning(win | 1)
    k /= k.sum()
    pad = len(k) // 2
    return np.convolve(np.pad(a, pad, mode="edge"), k, mode="valid")


def tube_frame():
    """Centreline, tangents, the side vector (toward the cut, east) and half widths, survey frame."""
    cl = csv(ANA / "analysis_out_v9" / "centreline.csv")
    mo = csv(ANA / "analysis_out_v9" / "morphometry.csv")
    C = np.c_[cl["x"], cl["y"], cl["z"]]
    T = np.c_[cl["tx"], cl["ty"], cl["tz"]]
    side = np.c_[-T[:, 1], T[:, 0], np.zeros(len(T))]
    side /= np.linalg.norm(side, axis=1)[:, None]
    if side[:, 0].mean() < 0:
        side = -side
    width = smooth1d(np.nan_to_num(mo["width"], nan=10.0), 9)
    height = smooth1d(np.nan_to_num(mo["height"], nan=8.0), 9)
    return C, T, side, width, height


def plan_path(C, T, side, width):
    """A line through the free space of the tube, one point per station. Survey frame.

    The centreline of the analysis is the centroid of each cross-section, which
    in places lies inside a breakdown pile. Here every station gets a grid of
    candidate points in its cross-section plane, each scored by its distance to
    the nearest lidar return, and a dynamic programme picks one per station:
    as much clearance as there is up to 2.4 m, little movement between
    stations, a height near 45% of the void, and never on the side that the
    section view cuts away.
    """
    P = clean_interior()[0]
    tree = cKDTree(P)
    lat = np.arange(-6.0, 6.01, 0.25)
    dz = np.arange(-3.5, 4.01, 0.25)
    LA, DZ = np.meshgrid(lat, dz, indexing="ij")
    la, zz = LA.ravel(), DZ.ravel()
    n, m = len(C), la.size
    cand = C[:, None, :] + side[:, None, :] * la[None, :, None] + np.array([0, 0, 1.0])[None, None, :] * zz[None, :, None]
    clear = tree.query(cand.reshape(-1, 3), workers=-1)[0].reshape(n, m)
    # Inside the void: within the measured width and between the measured floor and ceiling of the
    # station, and with returns both to the left and to the right in the station slab.
    mo = csv(ANA / "analysis_out_v9" / "morphometry.csv")
    zf = np.nan_to_num(mo["z_floor"], nan=-1e9)
    zc = np.nan_to_num(mo["z_ceil"], nan=1e9)
    k = cKDTree(C[:, :2]).query(P[:, :2], workers=-1)[1]
    inside = np.zeros((n, m), bool)
    for s in range(n):
        sel = (k >= s - 1) & (k <= s + 1)
        q = P[sel] - C[s]
        ql, qz = q @ side[s], q[:, 2]
        H = np.histogram2d(ql, qz, bins=[np.r_[lat - 0.125, lat[-1] + 0.125], np.r_[dz - 0.125, dz[-1] + 0.125]])[0] > 0
        left = np.maximum.accumulate(H, 0)
        right = np.flip(np.maximum.accumulate(np.flip(H, 0), 0), 0)
        zabs = C[s, 2] + zz
        inside[s] = (left & right).ravel() & (zabs > zf[s] + 0.6) & (zabs < zc[s] - 0.6)
    cost = -3.0 * np.minimum(clear, 2.4) + 40.0 * np.clip(1.3 - clear, 0, None) + 0.12 * np.abs(la)[None, :] + 0.2 * np.abs(zz)[None, :]
    cost[~inside] += 60.0
    # Stay off the side the section removes, with room for the airframe.
    cost[la[None, :] > CUT_N * width[:, None] / 2 - 1.0] += 30.0
    step = 4.0 * ((la[:, None] - la[None, :]) ** 2 + (zz[:, None] - zz[None, :]) ** 2)
    acc = cost[0].copy()
    back = np.zeros((n, m), np.int32)
    for s in range(1, n):
        tot = acc[:, None] + step
        back[s] = np.argmin(tot, axis=0)
        acc = tot[back[s], np.arange(m)] + cost[s]
    j = int(np.argmin(acc))
    pick = np.zeros(n, np.int32)
    for s in range(n - 1, -1, -1):
        pick[s] = j
        j = back[s, j]
    L = cand[np.arange(n), pick]
    d0 = clear[np.arange(n), pick]
    print(f"path as picked: clearance min {d0.min():.2f} m at station {int(d0.argmin())}, 5th percentile {np.percentile(d0, 5):.2f} m")
    # Smooth lightly, then let each station slide to the best clearance within half a metre, twice.
    for _ in range(2):
        L = np.c_[smooth1d(L[:, 0], 5), smooth1d(L[:, 1], 5), smooth1d(L[:, 2], 5)]
        dd = np.linalg.norm(cand - L[:, None, :], axis=2)
        sc = np.where((dd < 0.5) & inside, np.minimum(clear, 2.4) - 0.3 * dd, -1.0)
        j = np.argmax(sc, axis=1)
        ok = sc[np.arange(n), j] > 0
        L[ok] = 0.5 * L[ok] + 0.5 * cand[np.arange(n), j][ok]
    L = np.c_[smooth1d(L[:, 0], 5), smooth1d(L[:, 1], 5), smooth1d(L[:, 2], 5)]
    d = tree.query(L, workers=-1)[0]
    print(f"path: clearance min {d.min():.2f} m, 5th percentile {np.percentile(d, 5):.2f} m, median {np.median(d):.2f} m; "
          f"off the centroid line by up to {np.linalg.norm(L - C, axis=1).max():.2f} m")
    return L, d


def shaft_point(c, hole, zmin):
    """Where to fly a shaft: the point near the opening's centroid whose vertical line keeps farthest from the rock above zmin."""
    P = clean_interior()[0]
    near = P[(np.hypot(P[:, 0] - c[0], P[:, 1] - c[1]) < hole["semi_major"] + 4.0) & (P[:, 2] > zmin)]
    tree = cKDTree(near[:, :2])
    best, bp = -1.0, c[:2]
    r = hole["semi_major"]
    for dx in np.arange(-r, r + 0.01, 0.2):
        for dy in np.arange(-r, r + 0.01, 0.2):
            d = tree.query([c[0] + dx, c[1] + dy])[0]
            if d > best:
                best, bp = d, (c[0] + dx, c[1] + dy)
    print(f"shaft at ({bp[0]:.1f}, {bp[1]:.1f}): {best:.2f} m to the nearest return in plan, centroid moved {np.hypot(bp[0] - c[0], bp[1] - c[1]):.2f} m")
    return np.array([bp[0], bp[1], c[2]])


def build_flight():
    """The concept flight, simulated. Survey frame.

    A reference path (lander, first skylight, toward the entrance, the whole
    tube, back to the largest skylight, lander) is given a speed profile with
    limited acceleration, and a vehicle model follows it: a second-order
    response in position, with the airframe tilted so that its thrust axis
    lies along the commanded acceleration plus Mars gravity. In the tube the
    cruise speed follows the real mission (298 m in 560 s).

    Returns samples at FLIGHT_HZ: time, position, quaternion (x, y, z, w,
    body z up and body y forward), and the legs as (name, t0, t1).
    """
    cache = CACHE / "flight.npz"
    if cache.exists():
        d = np.load(cache, allow_pickle=True)
        return d["t"], d["p"], d["q"], [tuple(x) for x in d["legs"]], d["lander"], tuple(d["ks"])
    C, T, side, width, height = tube_frame()
    holes = json.load(open(ANA / "analysis_out_v9" / "aerial_holes.json"))["holes"]
    L, clear = plan_path(C, T, side, width)

    # The lander stands on the ground the page draws (the near tile), not on the closed envelope.
    Hn = np.load(CACHE / "near_h.npy")
    tm = json.load(open(CACHE / "terrain_meta.json"))["near"]

    def ground(x, y):
        sx, sz = x - X0, -(y - Y0)
        return float(ndimage.map_coordinates(Hn, [[(sz - tm["z0"]) / tm["res"]], [(sx - tm["x0"]) / tm["res"]]], order=1)[0]) + Z0

    z, xmin, ymin, res = load_dem()
    zs = fill_nearest(z, ~np.isfinite(z))
    def shaft(h):
        c = np.array(h["centroid"])
        k = int(np.argmin(np.hypot(C[:, 0] - c[0], C[:, 1] - c[1])))
        p = shaft_point(c, h, L[k, 2] + 1.2)
        return p, int(np.argmin(np.hypot(L[:, 0] - p[0], L[:, 1] - p[1])))

    s1, k1 = shaft(holes[0])
    s3, k3 = shaft(holes[2])
    # Lander: on the side that the section does not cut away, on the flattest spot 15 to 21 m from the first skylight.
    best = None
    for dist in (15, 17, 19, 21):
        for kk in (k1 - 6, k1, k1 + 6):
            p = C[kk, :2] - dist * side[kk, :2]
            gi, gj = int((p[0] - xmin) / res), int((p[1] - ymin) / res)
            score = zs[gi - 8:gi + 9, gj - 8:gj + 9].std() + 0.02 * dist
            if best is None or score < best[0]:
                best = (score, p)
    lp = best[1]
    lander = np.array([lp[0], lp[1], ground(lp[0], lp[1])])
    deck = lander + [0, 0, 1.24]  # rotorcraft origin when its feet stand on the 0.9 m deck
    cruise_z = max(ground(s1[0], s1[1]), lander[2]) + 6.0
    up = np.array([lander[0], lander[1], cruise_z])
    over1 = np.array([s1[0], s1[1], cruise_z])
    over3 = np.array([s3[0], s3[1], cruise_z])
    # Under each skylight lies a rubble cone, so the craft goes down the shaft only as far as it has
    # 1.2 m of room, then crosses to the planned line at the nearest station.
    tree = cKDTree(clean_interior()[0])

    def foot(sxy, k):
        zs_ = np.arange(cruise_z, L[k, 2] - 0.01, -0.1)
        d = tree.query(np.c_[np.full(len(zs_), sxy[0]), np.full(len(zs_), sxy[1]), zs_])[0]
        tight = np.nonzero((d < 1.2) & (zs_ < sxy[2]))[0]
        zf_ = zs_[tight[0] - 1] if tight.size else L[k, 2]
        f = np.array([sxy[0], sxy[1], zf_])
        seg = np.linspace(f, L[k], 12)
        print(f"shaft foot {zf_ - L[k, 2]:+.1f} m above the planned line; crossing to it keeps {tree.query(seg)[0].min():.2f} m clear")
        return f

    foot1 = foot(s1, k1)
    foot3 = foot(s3, k3)
    # The low passage at the entrance end is too tight to fly; turn back where the line has a metre of room.
    kt = int(np.nonzero(clear[:k1] < 1.0)[0].max()) + 1 if (clear[:k1] < 1.0).any() else 3

    # Reference legs: points, cruise speed (None: from the tube width), dwell at the end.
    legs_def = [
        ("takeoff", np.linspace(deck, up, 20), 0.7, 2.0),
        ("transit", np.linspace(up, over1, 40), 1.4, 2.5),
        ("descent", np.linspace(over1, foot1, 40), 0.45, 4.0),
        ("backtrack", np.vstack([foot1, L[k1:kt - 1:-1]]), None, 5.0),
        ("traverse", L[kt:len(L) - 2], None, 4.0),
        ("return", np.vstack([L[len(L) - 3:k3 - 1:-1], foot3]), 0.9, 3.0),
        ("ascent", np.linspace(foot3, over3, 40), 0.55, 2.0),
        ("home", np.linspace(over3, up, 60), 1.6, 2.5),
        ("landing", np.linspace(up, deck, 20), 0.4, 0.0),
    ]
    A_MAX = 0.22
    dt = 0.02
    ref_t, ref_p, legs = [], [], []
    t = 0.0
    for name, pts, cruise, dwell in legs_def:
        pts = np.asarray(pts, dtype=np.float64)
        seg = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))]
        keep = np.r_[True, np.diff(seg) > 1e-6]
        pts, seg = pts[keep], seg[keep]
        n = max(int(seg[-1] / 0.05), 2)
        sd = np.linspace(0, seg[-1], n)
        P = np.c_[[np.interp(sd, seg, pts[:, a]) for a in range(3)]].T
        if cruise is None:
            kk = cKDTree(C).query(P)[1]
            vlim = np.clip(0.2 + 0.035 * width[kk], 0.38, 0.72)
        else:
            vlim = np.full(n, cruise)
        # Start and end at rest; limit acceleration forward and backward along the path.
        v = vlim.copy()
        v[0] = v[-1] = 0.02
        ds = sd[1] - sd[0]
        for i in range(1, n):
            v[i] = min(v[i], np.sqrt(v[i - 1] ** 2 + 2 * A_MAX * ds))
        for i in range(n - 2, -1, -1):
            v[i] = min(v[i], np.sqrt(v[i + 1] ** 2 + 2 * A_MAX * ds))
        tt = t + np.r_[0, np.cumsum(ds / (0.5 * (v[1:] + v[:-1])))]
        legs.append((name, float(tt[0]), float(tt[-1])))
        ref_t.append(tt)
        ref_p.append(P)
        t = float(tt[-1]) + dwell
    ref_t = np.concatenate(ref_t)
    ref_p = np.vstack(ref_p)
    tg = np.arange(0, ref_t[-1] + 3.0, dt)
    ref = np.c_[[np.interp(tg, ref_t, ref_p[:, a]) for a in range(3)]].T

    # Vehicle: critically damped second-order response to the reference, horizontal a little softer than vertical.
    p = ref[0].copy()
    v = np.zeros(3)
    wn = np.array([1.5, 1.5, 2.2])
    P = np.zeros_like(ref)
    Acc = np.zeros_like(ref)
    # The reference velocity and acceleration are fed forward, so the vehicle stays on the planned
    # line through bends instead of cutting them.
    rv = np.gradient(ref, dt, axis=0)
    ra = ndimage.gaussian_filter1d(np.gradient(rv, dt, axis=0), 0.6 / dt, axis=0)
    for i in range(len(tg)):
        a = wn**2 * (ref[i] - p) + 2 * wn * (rv[i] - v) + ra[i]
        a[:2] = np.clip(a[:2], -0.38, 0.38)
        a[2] = np.clip(a[2], -0.5, 0.5)
        v += a * dt
        p += v * dt
        P[i], Acc[i] = p, a
    Vel = np.gradient(P, dt, axis=0)
    # Heading: along the horizontal velocity while moving, held while hovering, with a limited turn rate.
    yaw = np.zeros(len(tg))
    cur = np.arctan2(over1[0] - up[0], over1[1] - up[1])  # face the first skylight on the pad
    rate = np.radians(28.0)
    for i in range(len(tg)):
        sp = np.hypot(Vel[i, 0], Vel[i, 1])
        if sp > 0.12:
            want = np.arctan2(Vel[i, 0], Vel[i, 1])
            d = np.arctan2(np.sin(want - cur), np.cos(want - cur))
            cur += np.clip(d, -rate * dt, rate * dt) * min(1.0, sp / 0.3)
        else:
            # Look where the path goes next.
            j = min(i + int(6.0 / dt), len(tg) - 1)
            dx, dy = ref[j, 0] - P[i, 0], ref[j, 1] - P[i, 1]
            if np.hypot(dx, dy) > 0.6:
                want = np.arctan2(dx, dy)
                d = np.arctan2(np.sin(want - cur), np.cos(want - cur))
                cur += np.clip(d, -rate * dt, rate * dt)
        yaw[i] = cur
    yaw = np.unwrap(yaw)
    yaw = ndimage.gaussian_filter1d(yaw, 0.35 / dt)
    # Attitude: body z along (acceleration + gravity), then the heading. Smooth the thrust axis as an airframe would.
    thrust = Acc + np.array([0, 0, G_MARS])
    thrust = ndimage.gaussian_filter1d(thrust, 0.25 / dt, axis=0)
    bz = thrust / np.linalg.norm(thrust, axis=1)[:, None]
    fwd = np.c_[np.sin(yaw), np.cos(yaw), np.zeros(len(tg))]
    bx = np.cross(fwd, bz)
    bx /= np.linalg.norm(bx, axis=1)[:, None]
    by = np.cross(bz, bx)
    step = int(round(1.0 / (FLIGHT_HZ * dt)))
    idx = np.arange(0, len(tg), step)
    # Rotation matrices to quaternions, in the scene frame: scene (X, Y, Z) = (x, z, -y).
    def to_s(v):
        return np.stack([v[:, 0], v[:, 2], -v[:, 1]], axis=-1)
    Rx, Ry, Rz = to_s(bx[idx]), to_s(bz[idx]), to_s(by[idx])  # model axes: x right, y up, z forward
    # Keep the frame right-handed after the axis change.
    Rx = np.cross(Ry, Rz)
    from scipy.spatial.transform import Rotation
    q = Rotation.from_matrix(np.stack([Rx, Ry, Rz], axis=-1)).as_quat()
    for i in range(1, len(q)):
        if np.dot(q[i], q[i - 1]) < 0:
            q[i] = -q[i]
    tilt = np.degrees(np.arccos(np.clip(bz[:, 2], -1, 1)))
    print(f"flight: {tg[-1]:.0f} s, max speed {np.linalg.norm(Vel, axis=1).max():.2f} m/s, tilt median {np.median(tilt):.2f} deg, max {tilt.max():.1f} deg, tracking error max {np.linalg.norm(P - ref, axis=1).max():.2f} m")
    dcl = cKDTree(clean_interior()[0]).query(P[idx], workers=-1)[0]
    for name, a, b_ in legs:
        sel = (tg[idx] >= a) & (tg[idx] <= b_)
        print(f"  {name:10s} clearance of the flown line: min {dcl[sel].min():.2f} m, 5th percentile {np.percentile(dcl[sel], 5):.2f} m")
    np.savez(cache, t=tg[idx], p=P[idx], q=q, legs=np.array(legs, dtype=object), lander=lander, ks=np.array([k1, k3, kt]))
    return tg[idx], P[idx], q, legs, lander, (k1, k3, kt)


def stage_cloud():
    """The interior lidar map for the page: positions, first-seen time, normal and intensity.

    Dense file (about 1.2 million points) for the section views and a light
    one for small devices. A point is first seen when the simulated lidar, 15 m
    of range on the flight path, has a clear line to it through the fitted mesh.
    """
    import open3d as o3d

    P, N, I, K = clean_interior()
    C, T, side, width, height = tube_frame()
    m = np.load(CACHE / "tube_mesh.npz")
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(m["V"].astype(np.float32)), o3d.core.Tensor(m["F"].astype(np.uint32)))
    ft, fp, fq, legs, lander, _ = build_flight()
    seg = np.r_[0, np.cumsum(np.linalg.norm(np.diff(fp, axis=0), axis=1))]
    sd = np.arange(0, seg[-1], 0.5)
    sp = np.c_[[np.interp(sd, seg, fp[:, a]) for a in range(3)]].T
    st = np.interp(sd, seg, ft)
    RANGE = 15.0

    def export(name, target):
        # A random draw of the returns. A voxel grid would give the count too, but it lays the points on a
        # lattice that shows on the walls as a screen pattern.
        pick = np.sort(np.random.default_rng(7).choice(len(P), size=min(target, len(P)), replace=False))
        Q = P[pick]
        vox = float(np.median(cKDTree(Q).query(Q[::50], k=2, workers=-1)[0][:, 1]))
        kq = cKDTree(P).query(Q, workers=-1)[1]
        Nq = N[kq]
        # Lidar intensity is noisy from return to return; average it over the nearest returns so it reads as rock texture.
        nb = cKDTree(Q).query(Q, k=28, workers=-1)[1]
        Iq = I[kq][nb].mean(1)
        Nq = Nq[nb].mean(1)
        Nq /= np.maximum(np.linalg.norm(Nq, axis=1), 1e-6)[:, None]
        seen = np.full(len(Q), np.inf)
        tree = cKDTree(Q)
        t_under = dict((n, a) for n, a, b in legs)["descent"] + 12.0  # the lidar starts mapping as the craft passes the rim
        for p, t in zip(sp, st):
            if t < t_under:
                continue
            idx = np.array(tree.query_ball_point(p, RANGE))
            if idx.size == 0:
                continue
            idx = idx[~np.isfinite(seen[idx])]
            if idx.size == 0:
                continue
            v = Q[idx] - p
            d = np.linalg.norm(v, axis=1)
            rays = np.c_[np.broadcast_to(p.astype(np.float32), (len(idx), 3)), (v / d[:, None]).astype(np.float32)]
            hit = scene.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy()
            seen[idx[hit >= d - 0.45]] = t
        never = ~np.isfinite(seen)
        late = st >= t_under
        seen[never] = st[late][cKDTree(sp[late]).query(Q[never])[1]] + 2.0
        order = np.argsort(seen, kind="stable")
        Q, seen, Nq, Iq = Q[order], seen[order], Nq[order], Iq[order]
        S = to_scene(Q)
        Ns = np.stack([Nq[:, 0], Nq[:, 2], -Nq[:, 1]], axis=-1)
        lo, hi = S.min(0) - 0.01, S.max(0) + 0.01
        tscale = float(seen.max()) / 65535.0
        # Normal as two signed bytes: octahedral encoding.
        o = Ns / np.abs(Ns).sum(1)[:, None]
        neg = o[:, 1] < 0
        ox = np.where(neg, (1 - np.abs(o[:, 2])) * np.sign(o[:, 0] + 1e-9), o[:, 0])
        oz = np.where(neg, (1 - np.abs(o[:, 0])) * np.sign(o[:, 2] + 1e-9), o[:, 2])
        p1, p99 = np.percentile(Iq, [1, 99])
        rec = np.zeros(len(Q), dtype=[("p", "<u2", 3), ("t", "<u2"), ("n", "i1", 2), ("i", "u1")])
        rec["p"] = np.round((S - lo) / (hi - lo) * 65535)
        rec["t"] = np.round(seen / tscale)
        rec["n"] = np.clip(np.round(np.c_[ox, oz] * 127), -127, 127)
        rec["i"] = np.clip(np.round((Iq - p1) / (p99 - p1) * 255), 0, 255)
        rec.tofile(OUT / name)
        print(f"{name}: {len(Q):,} points at {vox:.2f} m, {rec.nbytes / 1e6:.1f} MB, {never.mean() * 100:.1f}% placed by closest approach")
        return {"file": name, "count": int(len(Q)), "bbox": {"min": lo.tolist(), "max": hi.tolist()}, "timeScale": tscale, "duration": float(seen.max()), "voxel": vox, "range": RANGE}

    meta = {"dense": export("cloud_dense.bin", 1_250_000), "lite": export("cloud.bin", 380_000)}
    json.dump(meta, open(CACHE / "cloud_meta.json", "w"))

    # The section: where the cut meets the void, per station (ceiling and floor at the cut line).
    k = cKDTree(C[:, :2]).query(P[:, :2], workers=-1)[1]
    lat = np.einsum("ij,ij->i", P - C[k], side[k])
    cut = CUT_N * width[k] / 2
    near = np.abs(lat - cut) < 0.45
    ceil = np.full(len(C), np.nan)
    floor = np.full(len(C), np.nan)
    for s in range(len(C)):
        zz = P[near & (k == s), 2]
        if zz.size < 6:
            continue
        mid = C[s, 2]
        upp, low = zz[zz > mid], zz[zz <= mid]
        if upp.size:
            ceil[s] = np.percentile(upp, 20)
        if low.size:
            floor[s] = np.percentile(low, 80)
    good = np.isfinite(ceil)
    ceil = np.interp(np.arange(len(C)), np.nonzero(good)[0], ceil[good])
    good = np.isfinite(floor)
    floor = np.interp(np.arange(len(C)), np.nonzero(good)[0], floor[good])
    np.savez(CACHE / "section.npz", ceil=smooth1d(ceil, 5), floor=smooth1d(floor, 5))


# --------------------------------------------------------------------------- meta


def stage_meta():
    cl = csv(ANA / "analysis_out_v9" / "centreline.csv")
    mo = csv(ANA / "analysis_out_v9" / "morphometry.csv")
    ro = csv(ANA / "analysis_out_v9" / "roof_thickness.csv")
    pn = json.load(open(ANA / "analysis_out_v9" / "paper_numbers.json"))
    rs = json.load(open(ANA / "analysis_out_v9" / "review_stats.json"))
    holes = json.load(open(ANA / "analysis_out_v9" / "aerial_holes.json"))["holes"]
    ft, fp, fq, legs, lander, (k1, k3, kt) = build_flight()
    Cx, Tx, side, width, height = tube_frame()
    sec = np.load(CACHE / "section.npz")
    C = to_scene(np.c_[cl["x"], cl["y"], cl["z"]])
    T = np.c_[cl["tx"], cl["tz"], -cl["ty"]]
    stations = {
        "s": cl["s"].tolist(),
        "pos": np.round(C, 3).tolist(),
        "tan": np.round(T, 4).tolist(),
        "side": np.round(np.c_[side[:, 0], side[:, 2], -side[:, 1]], 4).tolist(),
        "halfWidth": np.round(width / 2, 2).tolist(),
        "width": np.round(np.nan_to_num(mo["width"], nan=0.0), 2).tolist(),
        "height": np.round(np.nan_to_num(mo["height"], nan=0.0), 2).tolist(),
        "floor": np.round(np.nan_to_num(mo["z_floor"], nan=Z0) - Z0, 3).tolist(),
        "ceil": np.round(ro["z_ceil"] - Z0, 3).tolist(),
        "dem": np.round(ro["z_dem"] - Z0, 3).tolist(),
        "tau": np.round(ro["tau"], 3).tolist(),
        "span": np.round(ro["span"], 2).tolist(),
        "cls": [str(c) for c in ro["class"]],
        "cutCeil": np.round(sec["ceil"] - Z0, 3).tolist(),
        "cutFloor": np.round(sec["floor"] - Z0, 3).tolist(),
    }
    sk = []
    for i, h in enumerate(holes):
        c = to_scene(np.array(h["centroid"]))
        sk.append({"id": f"S{i + 1}" if i < 3 else "rejected", "pos": np.round(c, 3).tolist(), "semiMajor": h["semi_major"],
                   "semiMinor": max(h["semi_minor"], 0.4), "angle": -h["orientation"], "matched": i < 3})
    vres = [-v / 1000.0 for v in pn["reg_vres_mm"]]
    meta = {
        "note": "Interior cloud and tube mesh (the map built on board during the first long flight), near terrain, centreline, overburden and skylight ellipses are the Raufarholshellir survey. Far terrain, craters, the flight and first-seen times are generated.",
        "frame": {"x0": X0, "y0": Y0, "z0": Z0, "scene": "X = x - x0, Y = z - z0, Z = -(y - y0)"},
        "terrain": json.load(open(CACHE / "terrain_meta.json")),
        "cloud": json.load(open(CACHE / "cloud_meta.json")),
        "cutN": CUT_N,
        "stations": stations,
        "skylights": sk,
        "lander": np.round(to_scene(lander), 3).tolist(),
        "flight": {
            "hz": FLIGHT_HZ,
            "pos": np.round(to_scene(fp), 3).tolist(),
            "quat": np.round(fq, 4).tolist(),
            "legs": [{"name": n, "t0": round(a, 2), "t1": round(b, 2)} for n, a, b in legs],
            "duration": float(ft[-1]),
            "stationS1": int(k1), "stationS3": int(k3), "stationTurn": int(kt),
        },
        "registration": {"centroidVerticalOffset": vres, "rimRms": pn["reg_rim_rms_m"], "sigma": pn["reg_sigma_tau_m"]},
        "paper": {
            "tau": pn["tau"], "nIntact": pn["n_tau_clean"], "nSkylight": pn["n_skylight_stations"], "nStations": pn["n_stations"],
            "ciBlock30": rs["stats"]["ci_block"]["30"], "shielding": rs["shielding"],
            "strength": {k: pn["envelope"]["sigma_req_MPa"][k] for k in ("median", "p95", "max", "n")},
            "beta": pn["envelope"]["beta"], "rho": pn["envelope"]["rho_mid"], "length": pn["centreline_length_m"],
        },
    }

    def clean(o):
        # JSON has no NaN: stations without a value (no surface cell inside an opening) carry null.
        if isinstance(o, float):
            return None if not np.isfinite(o) else o
        if isinstance(o, dict):
            return {k: clean(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [clean(v) for v in o]
        return o
    json.dump(clean(meta), open(OUT / "meta.json", "w"), separators=(",", ":"), allow_nan=False)
    print(f"meta: {len(stations['s'])} stations, flight {ft[-1]:.0f} s in {len(ft)} samples, lander at {meta['lander']}")
    for n, a, b in legs:
        print(f"  {n:10s} {a:7.1f} to {b:7.1f} s")


if __name__ == "__main__":
    stages = sys.argv[1:] or ["terrain", "tube", "cloud", "meta"]
    for s in stages:
        {"terrain": stage_terrain, "tube": stage_tube, "cloud": stage_cloud, "meta": stage_meta}[s]()
