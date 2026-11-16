# /// script
# requires-python = ">=3.12"
# dependencies = ["resvg-py==0.5.0"]
# ///
"""Writes src/gallery/favicon.ico from src/gallery/icon.svg (docs/gallery/design.md, "Icon").

The ICO file holds the drawing rendered by resvg at 16 and 32 px, each stored as a PNG image. Run it after changing
icon.svg, from any directory: `uv run packages/worker/scripts/favicon.py`.
"""

import struct
from pathlib import Path

import resvg_py

GALLERY = Path(__file__).resolve().parent.parent / "src" / "gallery"
SIZES = (16, 32)

svg = (GALLERY / "icon.svg").read_text(encoding="utf-8")
images = [bytes(resvg_py.svg_to_bytes(svg_string=svg, width=size, height=size)) for size in SIZES]

# ICONDIR, then one ICONDIRENTRY per image (width, height, palette size, reserved, planes, bits per pixel, byte size,
# offset), then the images.
header = struct.pack("<HHH", 0, 1, len(images))
offset = len(header) + 16 * len(images)
entries = b""
for size, png in zip(SIZES, images, strict=True):
    entries += struct.pack("<BBBBHHII", size, size, 0, 0, 1, 32, len(png), offset)
    offset += len(png)
(GALLERY / "favicon.ico").write_bytes(header + entries + b"".join(images))
