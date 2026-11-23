#!/usr/bin/env python3
"""Figures and legends for the page, taken from the manuscript sources.

    python3 tools/build_content.py

Reads the manuscript directory next to this repository (sections/results.tex,
sections/extended_data_nature.tex, figures/), writes web copies of every
figure to public/figures/ and the legends, converted from LaTeX to HTML, to
src/content/figures.json. Run it again after the manuscript changes.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image

SITE = Path(__file__).resolve().parent.parent
ROOT = SITE.parent
MS = next(p for p in ROOT.iterdir() if p.is_dir() and p.name.startswith("_Nature__"))
OUT = SITE / "public" / "figures"
OUT.mkdir(parents=True, exist_ok=True)
Image.MAX_IMAGE_PIXELS = None


def strip_comments(t: str) -> str:
    return "\n".join(l for l in t.split("\n") if not l.lstrip().startswith("%"))


def balanced(t: str, start: int) -> tuple[str, int]:
    """Text of the brace group that opens at t[start] == '{', and the index after it."""
    depth, i = 0, start
    while i < len(t):
        if t[i] == "{" and t[i - 1] != "\\":
            depth += 1
        elif t[i] == "}" and t[i - 1] != "\\":
            depth -= 1
            if depth == 0:
                return t[start + 1:i], i + 1
        i += 1
    raise ValueError("unbalanced braces")


ACCENTS = {r"\'o": "ó", r"\'O": "Ó", r"\=a": "ā", r"\dh{}": "ð", r"\dh ": "ð", r"\ae{}": "æ", r"\aa{}": "å", r"\TH{}": "Þ", r"\'a": "á", r"\'e": "é", r"\'i": "í"}


def tex_to_html(s: str, labels: dict[str, str]) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    for k, v in ACCENTS.items():
        s = s.replace(k, v)
    s = re.sub(r"\s*\\cite\{[^}]*\}", "", s)
    s = re.sub(r"Fig\.~\\ref\{([^}]*)\}", lambda m: f"Fig. {labels.get(m.group(1), '?')}", s)
    s = re.sub(r"\\textbf\{([^}]*)\}", r"<b>\1</b>", s)
    s = re.sub(r"\\emph\{([^}]*)\}", r"<i>\1</i>", s)
    s = s.replace("``", "“").replace("''", "”")
    # Small maths: superscripts, plus-minus, times.
    s = re.sub(r"\$\^\{?(-?\d+)\}?\$", r"<sup>\1</sup>", s)
    s = re.sub(r"\^\{(-?\d+)\}", r"<sup>\1</sup>", s)
    s = s.replace(r"$\pm$", "±").replace(r"\pm", "±").replace(r"$\times$", "×").replace(r"$|$", "|")
    s = re.sub(r"\$([^$]*)\$", lambda m: m.group(1).replace("-", "−"), s)
    s = s.replace("~", "\u00a0").replace(r"\%", "%").replace("--", "–").replace(r"\,", "")
    s = re.sub(r"\\[a-zA-Z]+\{([^}]*)\}", r"\1", s)
    s = s.replace("{", "").replace("}", "")
    return s


def web_copy(stem: str, name: str, width: int = 1800) -> tuple[str, int, int]:
    """Render a manuscript figure to a JPEG at most `width` pixels wide."""
    src = None
    for ext in (".pdf", ".png", ".jpeg", ".jpg"):
        p = MS / "figures" / f"{stem}{ext}"
        if p.exists():
            src = p
            break
    if src is None:
        raise FileNotFoundError(stem)
    tmp = SITE / "tools" / ".cache" / f"{name}"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    if src.suffix == ".pdf":
        subprocess.run(["pdftoppm", "-r", "260", "-png", "-singlefile", str(src), str(tmp)], check=True, stderr=subprocess.DEVNULL)
        im = Image.open(f"{tmp}.png")
    else:
        im = Image.open(src)
    im = im.convert("RGB")
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    im.save(OUT / f"{name}.jpg", quality=86, optimize=True, progressive=True)
    th = im.resize((480, round(im.height * 480 / im.width)), Image.LANCZOS)
    th.save(OUT / f"{name}_thumb.jpg", quality=80, optimize=True)
    return f"figures/{name}.jpg", im.width, im.height


def main() -> None:
    res = strip_comments((MS / "sections" / "results.tex").read_text())
    ed = strip_comments((MS / "sections" / "extended_data_nature.tex").read_text())

    # Main figures, in the order they appear, numbered as LaTeX numbers them.
    figs = []
    labels: dict[str, str] = {}
    for m in re.finditer(r"\\begin\{figure\}.*?\\end\{figure\}", res, re.S):
        block = m.group(0)
        stem = re.search(r"\\fullfig\{([^}]*)\}", block).group(1)
        cap, end = balanced(block, block.index("\\caption") + len("\\caption"))
        label = re.search(r"\\label\{([^}]*)\}", block[end:]).group(1)
        labels[label] = str(len(figs) + 1)
        figs.append((stem, cap))
    main_figs = []
    for i, (stem, cap) in enumerate(figs, 1):
        title, _, body = cap.partition(".\n")
        if not body:
            title, _, body = cap.partition(". ")
        path, w, h = web_copy(stem, f"fig{i}")
        main_figs.append({"id": f"fig{i}", "label": f"Figure {i}", "title": tex_to_html(title, labels), "legend": tex_to_html(body, labels), "src": path, "thumb": f"figures/fig{i}_thumb.jpg", "w": w, "h": h})

    # Extended Data: \fullfig or \includegraphics followed by \edlegend{label | title}{legend}.
    ed_items = []
    for m in re.finditer(r"\\(?:fullfig|includegraphics(?:\[[^\]]*\])?)\{([^}]*)\}", ed):
        stem = m.group(1)
        k = ed.index("\\edlegend", m.end())
        head, e1 = balanced(ed, k + len("\\edlegend"))
        body, _ = balanced(ed, e1)
        label, _, title = head.partition("$|$")
        label_h = tex_to_html(label, labels)
        num = re.search(r"(Fig\.|Table)\s*(\d+)", label_h.replace("\u00a0", " "))
        name = ("ed_fig" if num.group(1) == "Fig." else "ed_table") + num.group(2)
        path, w, h = web_copy(stem, name)
        ed_items.append({"id": name, "label": label_h.strip(), "title": tex_to_html(title, labels).rstrip("."), "legend": tex_to_html(body, labels), "src": path, "thumb": f"figures/{name}_thumb.jpg", "w": w, "h": h})

    out = SITE / "src" / "content"
    out.mkdir(parents=True, exist_ok=True)
    json.dump({"main": main_figs, "extended": ed_items}, open(out / "figures.json", "w"), indent=1, ensure_ascii=False)
    print(f"{len(main_figs)} main figures, {len(ed_items)} Extended Data items")
    for f in main_figs + ed_items:
        print(f"  {f['label']:26s} {f['w']}x{f['h']}  {f['title'][:70]}")


if __name__ == "__main__":
    sys.exit(main())
