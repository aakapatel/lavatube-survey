# Project website: Autonomous interior survey of a lava tube

Page for the manuscript "Autonomous interior survey of a lava tube for planetary
habitat assessment" (Patel, Stathoulopoulos, Valdes Saucedo, Llewellin,
Óskarsson, Nikolakopoulos; under review, 2026). Published at
https://aakapatel.github.io/lavatube-survey/, the address the manuscript cites.

The top of the page is an interactive 3D module in three.js. It places the
paper's workflow on Mars as a concept: an orbiter builds a surface model, a
rotorcraft descends a skylight and maps the tube, the two maps are registered
through the skylights, and the rock cover is computed. The tube, the lidar map
and the ground relief in it are the survey of Raufarhólshellir. The section
"What the animation shows" on the page lists what is measured and what is added.

## Run it

Node 18 or newer.

```
npm install
npm run dev        # http://127.0.0.1:5183
npm run build      # type check, then static files in dist/
npm run preview
```

The build uses relative paths, so `dist/` works from any subpath.

## Layout

```
index.html              page text; figures and legends are filled in by src/ui/page.ts
src/main.ts             boot: page, then the 3D module, poster if WebGL is missing
src/styles.css          the stylesheet
src/hero/               the 3D module (engine.ts lists the parts)
src/ui/hero.ts          chapter bar, readouts, overburden chart and switches, scene labels
src/ui/page.ts          figures, figure viewer, citation button, optional video
src/content/figures.json   legends, written by tools/build_content.py
public/hero/            3D assets, written by tools/build_data.py and tools/models.py
public/figures/         web copies of the manuscript figures
tools/                  the scripts that make the assets, and screenshot helpers
```

## Rebuilding the assets

All assets are generated; none is edited by hand.

| Script | Reads | Writes |
|---|---|---|
| `tools/build_data.py` | `../lavatube_maps_data_analysis` (maps and `analysis_out_v9`) | terrain heights and texture, tube mesh, lidar cloud, `meta.json` |
| `tools/models.py` (Blender 4.5) | nothing | `orbiter.glb`, `rotorcraft.glb`, `lander.glb` |
| `tools/fetch_mars.py` | NASA Mars Trek tile service | `mars_strip_0.jpg` to `mars_strip_2.jpg` |
| `tools/build_content.py` | the manuscript's `sections/` and `figures/` | `public/figures/`, `src/content/figures.json` |

```
PY=../lavatube_maps_data_analysis/.venv/bin/python
$PY tools/build_data.py                 # terrain, tube, cloud, meta (about four minutes)
npx -y gltfpack@0.25.0 -i tools/.cache/tube_raw.glb -o public/hero/tube.glb -cc -vp 16 -vn 8 -vc 8 -kn
npx -y gltfpack@0.25.0 -i tools/.cache/tube_hi_raw.glb -o public/hero/tube_hi.glb -cc -vp 16 -vn 8 -vc 8 -kn
~/opt/blender-4.5.3-linux-x64/blender -b --factory-startup -P tools/models.py -- --out public/hero
python3 tools/build_content.py          # after the manuscript figures or legends change
```

The tube is drawn from the map built on board during the first long flight
(`tube_10cm_ed_ortho.pcd`). The offline map behind the paper's numbers agrees
with it to 0.2 m at 99% of points but holds second copies of some walls, up
to 3 m off, and a surface fitted to it has rock inside the void. The flight
is planned through the free space of that map and simulated; delete
`tools/.cache/flight.npz` to simulate it again, then run the `tube`, `cloud`
and `meta` stages.

`tools/reel.mjs` and `tools/shot.mjs` take screenshots of the running dev
server at chosen loop times, on the GPU, for checking a change (`BARE=1`
hides the interface, `CROP=x,y,w,h` cuts each frame), and `tools/motion.mjs`
checks that the picture changes while the mission plays. `tools/probe.mjs`
records where the camera is while the mission plays, and
`tools/camera_clearance.py` gives its distance to the nearest lidar return
and its speed inside each shot. Add `?quality=high` or `?quality=low` to the
address to force the full or the light mesh and point file.

## The video

Put the file at `public/video/supplementary_video_1.mp4` and a poster frame at
`public/video/poster.jpg`. The "Flight video" section appears when the file is
there and stays hidden when it is not.

## Publishing

`.github/workflows/pages.yml` builds the site and publishes `dist/` on every
push to `main`. It needs one setting in the repository: Settings > Pages >
Source: GitHub Actions. Until this branch is merged, `main` keeps serving the
previous static page.

## Sources and licences

Site content CC BY 4.0. The imagery of Mars is the Viking MDIM 2.1 colour
mosaic (NASA, JPL, USGS; public domain), the strip under the orbit from the
NASA Mars Trek tile service. Surface survey products: Natural
Science Institute of Iceland, surveyor B. V. Óskarsson. Vehicle models are
generic and were made for this page.
