#!/usr/bin/env python3
"""Normalize an image-generated pet sheet into the app's v2 atlas contract."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageOps


COLUMNS = 8
TARGET_ROWS = 11
CELL_WIDTH = 192
CELL_HEIGHT = 208
FRAME_COUNTS = (6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8)
NINE_ROW_MAPPING = (0, 1, 1, 2, 3, 4, 5, 6, 6, 7, 8)


def source_cell(image: Image.Image, row: int, column: int, rows: int) -> Image.Image:
    left = round(column * image.width / COLUMNS)
    right = round((column + 1) * image.width / COLUMNS)
    top = round(row * image.height / rows)
    bottom = round((row + 1) * image.height / rows)
    return image.crop((left, top, right, bottom))


def fit_cell(cell: Image.Image, gutter: int, recenter_x: bool) -> Image.Image:
    available_width = CELL_WIDTH - gutter * 2
    available_height = CELL_HEIGHT - gutter * 2
    scale = min(available_width / cell.width, available_height / cell.height)
    size = (
        max(1, round(cell.width * scale)),
        max(1, round(cell.height * scale)),
    )
    resized = cell.resize(size, Image.Resampling.LANCZOS)
    output = Image.new("RGBA", (CELL_WIDTH, CELL_HEIGHT), (0, 0, 0, 0))
    x = (CELL_WIDTH - resized.width) // 2
    y = (CELL_HEIGHT - resized.height) // 2
    output.alpha_composite(resized, (x, y))

    if recenter_x:
        bounds = output.getchannel("A").getbbox()
        if bounds:
            left, _, right, _ = bounds
            desired_shift = round(CELL_WIDTH / 2 - (left + right) / 2)
            min_shift = gutter - left
            max_shift = CELL_WIDTH - gutter - right
            shift = max(min_shift, min(max_shift, desired_shift))
            if shift:
                centered = Image.new("RGBA", output.size, (0, 0, 0, 0))
                centered.alpha_composite(output, (shift, 0))
                output = centered
    return output


def clear_transparent_rgb(image: Image.Image) -> Image.Image:
    data = bytearray(image.tobytes())
    for index in range(0, len(data), 4):
        if data[index + 3] == 0:
            data[index : index + 3] = b"\x00\x00\x00"
    return Image.frombytes("RGBA", image.size, bytes(data))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source-rows", required=True, type=int, choices=(9, 11))
    parser.add_argument(
        "--gutter",
        type=int,
        default=0,
        choices=range(0, 33),
        metavar="PX",
        help="Inset every source cell by this many pixels to prevent edge clipping.",
    )
    parser.add_argument(
        "--recenter-x",
        action="store_true",
        help="Center each visible silhouette horizontally after fitting the cell.",
    )
    args = parser.parse_args()

    with Image.open(args.input) as opened:
        source = opened.convert("RGBA")

    atlas = Image.new(
        "RGBA",
        (COLUMNS * CELL_WIDTH, TARGET_ROWS * CELL_HEIGHT),
        (0, 0, 0, 0),
    )
    row_mapping = range(TARGET_ROWS) if args.source_rows == TARGET_ROWS else NINE_ROW_MAPPING

    for target_row, source_row in enumerate(row_mapping):
        for column in range(FRAME_COUNTS[target_row]):
            cell = source_cell(source, source_row, column, args.source_rows)
            if args.source_rows == 9 and target_row == 2:
                cell = ImageOps.mirror(cell)
            atlas.alpha_composite(
                fit_cell(cell, args.gutter, args.recenter_x),
                (column * CELL_WIDTH, target_row * CELL_HEIGHT),
            )

    neutral = fit_cell(
        source_cell(source, 0, 0, args.source_rows),
        args.gutter,
        args.recenter_x,
    )
    atlas.alpha_composite(neutral, (6 * CELL_WIDTH, 0))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    atlas = clear_transparent_rgb(atlas)
    if args.output.suffix.lower() == ".webp":
        atlas.save(args.output, "WEBP", lossless=True, method=6, exact=True)
    else:
        atlas.save(args.output, "PNG", optimize=True)


if __name__ == "__main__":
    main()
