#!/usr/bin/env python3
"""Distance from the camera to the nearest lidar return, from the samples of tools/probe.mjs.

    ../lavatube_maps_data_analysis/.venv/bin/python tools/camera_clearance.py probe.json

A camera inside the rock or grazing a wall shows up as a clearance near zero.
"""
import json
import sys

import numpy as np
from scipy.spatial import cKDTree

import build_data as b

rows = json.load(open(sys.argv[1]))[5:]  # the first samples precede the first frame after the seek
P = b.to_scene(b.clean_interior()[0])
tree = cKDTree(P)
cam = np.array([r["cam"] for r in rows])
craft = np.array([r["craft"] for r in rows])
t = np.array([r["t"] for r in rows])
d = tree.query(cam, workers=-1)[0]
sep = np.linalg.norm(cam - craft, axis=1)
step = np.linalg.norm(np.diff(cam, axis=0), axis=1) / np.maximum(np.diff(t), 1e-3)
for view in sorted({r["view"] for r in rows}):
    s = np.array([r["view"] == view for r in rows])
    under = s & (d < 6)  # only where the camera is near rock at all
    if under.any():
        i = np.nonzero(under)[0][np.argmin(d[under])]
        print(f"{view:7s} {s.sum():5d} samples; near rock: clearance min {d[under].min():.2f} m at t = {t[i]:.1f} s, 5th percentile {np.percentile(d[under], 5):.2f} m; "
              f"camera to craft {sep[s].min():.1f} to {sep[s].max():.1f} m")
    else:
        print(f"{view:7s} {s.sum():5d} samples; never within 6 m of rock; camera to craft {sep[s].min():.1f} to {sep[s].max():.1f} m")
# Camera speed inside the shots. Samples within 0.3 s of a cut are left out: there the camera is meant to jump.
views = np.array([r["view"] for r in rows])
cuts = t[1:][views[1:] != views[:-1]]
mid = 0.5 * (t[1:] + t[:-1])
sel = (np.diff(t) < 0.5) & (np.diff(t) > 0) & np.array([np.all(np.abs(m - cuts) > 0.3) for m in mid])
j = np.nonzero(sel)[0][np.argmax(step[sel])]
print(f"fastest camera movement inside a shot: {step[sel].max():.1f} m/s at t = {t[j]:.1f} s (median {np.median(step[sel]):.1f} m/s)")
d1 = (t[:-1] > 44) & (t[:-1] < 69) & sel
acc = np.abs(np.diff(step[d1])) / np.maximum(np.diff(mid[d1]), 1e-3)
print(f"take-off to the first cut (44 to 69 s): camera speed at most {step[d1].max():.1f} m/s, largest change of speed between samples {np.abs(np.diff(step[d1])).max():.1f} m/s")
