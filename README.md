# Project website: Autonomous interior survey of a lava tube

Static project page for the manuscript "Autonomous interior survey of a lava tube
for planetary habitat assessment" (Patel, Stathoulopoulos, Llewellin, Óskarsson,
Nikolakopoulos; manuscript under review, 2026).

The site is plain HTML, CSS and a small script. There is no build step. It works
when `index.html` is opened from disk and on GitHub Pages at a repository subpath,
because every asset path is relative.

## Layout

```
index.html              the page
assets/css/style.css    stylesheet
assets/js/main.js       nav highlight, figure lightbox, copy-BibTeX button
assets/figures/         web copies of the five main figures, the ten
                        Extended Data items and the rim ground-truth figure
                        (max 1800 px wide, each under 700 KB)
.nojekyll               tells GitHub Pages to serve the files as they are
LICENSE                 CC BY 4.0 for the site content
```

## Enable GitHub Pages

1. Push this directory to a repository (as the root, or copy its contents into
   the repository root).
2. In the repository: Settings > Pages > Build and deployment > Source:
   "Deploy from a branch", Branch: `main`, Folder: `/ (root)`. Save.
3. The page appears at `https://<user>.github.io/<repo>/` within a few minutes.

`.nojekyll` must stay in the root so Pages does not run Jekyll over the files.

## Add the supplementary video

In `index.html`, section `id="video"`, delete the `<div class="video-placeholder">`
block and uncomment one of the two commented examples that follow it:

- Self-hosted: put the file at `assets/video/supplementary_video_1.mp4` and a
  poster frame at `assets/video/poster.jpg`. GitHub limits single files to 100 MB;
  keep the encode under that or use the YouTube option.
- YouTube: replace `VIDEO_ID` in the iframe `src`.

## Add data and code links

In section `id="data"`, each row has a link `<a class="pending" href="#">` followed
by a `<span class="badge">link to be added</span>`. For each released item, set the
`href` to the DOI or repository URL, remove `class="pending"` and
`aria-disabled="true"`, and delete the badge span.

## Add the preprint and the final citation

- Hero: the first button is `<a class="btn disabled" href="#">Preprint (coming
  soon)</a>`. Set the `href`, remove `disabled` from the class list, remove
  `aria-disabled`, and change the label.
- Cite: replace the `@unpublished` entry inside `<pre id="bibtex">` with the
  published reference. Escape non-ASCII characters in BibTeX as in the placeholder.

## Ground-truth section

Section `id="groundtruth"` reports the tape measurements of 15 September 2026
at the skylight rims against the registered model. Its figure
(`assets/figures/rim_groundtruth.png`) comes from
`lavatube_maps_data_analysis/analysis/make_web_groundtruth_figure.py` and its
table from `analysis_out_v9/skylight_groundtruth.csv`; if the comparison is
rerun, regenerate the figure, copy it at 1800 px wide, and update the table
cells by hand from the CSV.

## Regenerate figure copies

The web copies were made from the 300 dpi PNGs in
`lavatube_maps_data_analysis/analysis_out_v10/figures_nature/` with Python PIL:
resize to 1800 px wide, JPEG quality 85 for photographic figures (fig2, ed1,
ed3, ed4) and optimised PNG for the rest, falling back to JPEG when the PNG
exceeds 600 KB. Thumbnails for the Extended Data grid are 600 px JPEGs with the
suffix `_thumb`. The hero background `hero_fig3a.jpg` is a crop of Figure 3a.
If a figure changes, rerun the same conversion and keep the file names.

## License

Site text, layout and code: CC BY 4.0 (see `LICENSE`). Figures are from the
manuscript and follow its terms once published. The surface survey data belong
to the Natural Science Institute of Iceland.
