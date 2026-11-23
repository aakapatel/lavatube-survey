#!/usr/bin/env python3
"""Mars imagery under the orbiter's ground track, for the orbit chapter.

    python3 tools/fetch_mars.py

Downloads the Viking MDIM 2.1 colour mosaic (NASA, JPL, USGS; public domain)
from the NASA Mars Trek tile service at its finest level, 325 m per pixel at
the equator, for 18 degrees of longitude by 60 degrees of latitude around the
concept site, and writes it as three textures, north to south:
public/hero/mars_strip_0.jpg to mars_strip_2.jpg. Tiles are cached in
tools/.cache/trek.
"""
import concurrent.futures as cf
import os
import urllib.request
from pathlib import Path

from PIL import Image

SITE = Path(__file__).resolve().parent.parent
CACHE = SITE / "tools" / ".cache" / "trek"
OUT = SITE / "public" / "hero"
CACHE.mkdir(parents=True, exist_ok=True)
Z = 7
W, H = 256 * 2 ** (Z + 1), 256 * 2**Z
LON0, LON1, LAT_N, LAT_S = -128.5, -110.5, 12.0, -48.0
BASE = "https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm"


def get(rc):
    r, c = rc
    f = CACHE / f"{Z}_{r}_{c}.jpg"
    if not f.exists() or f.stat().st_size < 500:
        req = urllib.request.Request(f"{BASE}/{Z}/{r}/{c}.jpg", headers={"User-Agent": "lavatube-survey-site-build/1.0 (research project page)"})
        with urllib.request.urlopen(req, timeout=40) as u:
            f.write_bytes(u.read())
    return f


def main():
    x0, x1 = (LON0 + 180) / 360 * W, (LON1 + 180) / 360 * W
    y0, y1 = (90 - LAT_N) / 180 * H, (90 - LAT_S) / 180 * H
    c0, c1, r0, r1 = int(x0 // 256), int(x1 // 256), int(y0 // 256), int(y1 // 256)
    jobs = [(r, c) for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)]
    with cf.ThreadPoolExecutor(6) as ex:
        files = list(ex.map(get, jobs))
    mos = Image.new("RGB", ((c1 - c0 + 1) * 256, (r1 - r0 + 1) * 256))
    for (r, c), f in zip(jobs, files):
        mos.paste(Image.open(f).convert("RGB"), ((c - c0) * 256, (r - r0) * 256))
    crop = mos.crop((round(x0 - c0 * 256), round(y0 - r0 * 256), round(x1 - c0 * 256), round(y1 - r0 * 256)))
    print(f"{len(jobs)} tiles, strip {crop.size}")
    n = 3
    h = crop.height // n
    for i in range(n):
        part = crop.crop((0, i * h, crop.width, (i + 1) * h if i < n - 1 else crop.height))
        path = OUT / f"mars_strip_{i}.jpg"
        part.save(path, quality=86, optimize=True)
        print(f"  {path.name}: {part.size}, {os.path.getsize(path) / 1e6:.1f} MB")
    crop.resize((crop.width // 6, crop.height // 6)).save(CACHE / "preview.png")


if __name__ == "__main__":
    main()
