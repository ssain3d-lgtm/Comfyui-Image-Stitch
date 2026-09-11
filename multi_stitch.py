import functools
import hashlib
import json
import math
import re
from contextlib import contextmanager
from pathlib import Path
from typing import Callable

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

import folder_paths


_COLOR_MAP = {
    "white": (1.0, 1.0, 1.0),
    "black": (0.0, 0.0, 0.0),
    "red": (1.0, 0.0, 0.0),
    "green": (0.0, 1.0, 0.0),
    "blue": (0.0, 0.0, 1.0),
}

# A ComfyUI IMAGE is float32 RGB, so 128 MiPixels is already about 1.5 GiB
# for the final tensor alone. These guards run on file headers only, before
# any source image is decoded, so an accidental giant strip/grid is rejected
# cheaply. The output guard bounds the destination canvas. The source guard
# bounds each original as it is decoded: composition streams the sources one
# at a time into the canvas, so one decoded original plus the canvas is the
# whole working set, however many images the node holds.
_MAX_OUTPUT_PIXELS = 128 * 1024 * 1024
_MAX_OUTPUT_SIDE = 131_072
_MAX_SOURCE_PIXELS = 128 * 1024 * 1024
_MAX_IMAGES = 256  # mirrored by MAX_IMAGES in web/shared.js

_EXIF_ORIENTATION = 0x0112
# The same table Pillow's ImageOps.exif_transpose applies.
_ORIENTATION_TRANSPOSES = {
    2: Image.Transpose.FLIP_LEFT_RIGHT,
    3: Image.Transpose.ROTATE_180,
    4: Image.Transpose.FLIP_TOP_BOTTOM,
    5: Image.Transpose.TRANSPOSE,
    6: Image.Transpose.ROTATE_270,
    7: Image.Transpose.TRANSVERSE,
    8: Image.Transpose.ROTATE_90,
}
_ORIENTATIONS_THAT_SWAP_AXES = {5, 6, 7, 8}

_DIRECTIONS = ("right", "down", "left", "up")
_LAYOUT_MODES = ("strip", "grid")
_MATCH_REFERENCES = ("first", "largest", "smallest")
_OUTPUT_LIMITS = ("none", "max_width", "max_height", "max_long_side")


def _safe_input_path(item: dict) -> Path:
    """Resolve an uploaded ComfyUI input image without allowing path traversal."""
    filename = str(item.get("filename", "")).strip()
    subfolder = str(item.get("subfolder", "")).strip().replace("\\", "/")
    item_type = str(item.get("type", "input")).strip().lower()

    if not filename:
        raise ValueError("Multi Stitch Images: image entry has no filename.")
    if item_type not in {"input", "temp"}:
        raise ValueError(f"Multi Stitch Images: unsupported image type: {item_type}")

    base = Path(folder_paths.get_input_directory() if item_type == "input" else folder_paths.get_temp_directory()).resolve()
    relative = Path(subfolder) / filename if subfolder else Path(filename)
    candidate = (base / relative).resolve()

    try:
        candidate.relative_to(base)
    except ValueError as exc:
        raise ValueError("Multi Stitch Images: unsafe image path rejected.") from exc

    if not candidate.is_file():
        raise FileNotFoundError(f"Multi Stitch Images: image not found: {candidate}")
    return candidate


def _normalize_crop(crop: object) -> tuple[float, float, float, float]:
    if not isinstance(crop, dict):
        return 0.0, 0.0, 1.0, 1.0

    def number(name: str, fallback: float) -> float:
        try:
            value = float(crop.get(name, fallback))
        except (TypeError, ValueError):
            value = fallback
        if not math.isfinite(value):
            value = fallback
        return value

    x = min(max(number("x", 0.0), 0.0), 1.0)
    y = min(max(number("y", 0.0), 0.0), 1.0)
    w = min(max(number("w", 1.0), 0.0), 1.0 - x)
    h = min(max(number("h", 1.0), 0.0), 1.0 - y)

    if w <= 0.000001 or h <= 0.000001:
        return 0.0, 0.0, 1.0, 1.0
    return x, y, w, h


def _normalize_transform(item: dict) -> tuple[int, bool, bool]:
    try:
        degrees = float(item.get("rotation", 0))
    except (TypeError, ValueError):
        degrees = 0.0
    # json.loads accepts the non-standard Infinity/NaN literals, and round(inf)
    # raises OverflowError rather than ValueError, so screen the value first.
    if not math.isfinite(degrees):
        degrees = 0.0
    rotation = int(round(degrees / 90.0) * 90) % 360
    return rotation, bool(item.get("flip_h", False)), bool(item.get("flip_v", False))


def _apply_transform(image: Image.Image, item: dict) -> Image.Image:
    """Rotate first, then flip in the displayed/output coordinate system."""
    rotation, flip_h, flip_v = _normalize_transform(item)

    if rotation == 90:
        image = image.transpose(Image.Transpose.ROTATE_270)  # clockwise
    elif rotation == 180:
        image = image.transpose(Image.Transpose.ROTATE_180)
    elif rotation == 270:
        image = image.transpose(Image.Transpose.ROTATE_90)   # counter-clockwise

    if flip_h:
        image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if flip_v:
        image = image.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    return image


def _crop_box(width: int, height: int, crop: object) -> tuple[int, int, int, int]:
    x, y, w, h = _normalize_crop(crop)
    left = max(0, min(width - 1, int(round(x * width))))
    top = max(0, min(height - 1, int(round(y * height))))
    right = max(left + 1, min(width, int(round((x + w) * width))))
    bottom = max(top + 1, min(height, int(round((y + h) * height))))
    return left, top, right, bottom


@contextmanager
def _open_image(path: Path):
    """Open a source file, reporting Pillow failures in the node's own voice."""
    try:
        with Image.open(path) as image:
            yield image
    except Image.DecompressionBombError as exc:
        raise ValueError(
            f"Multi Stitch Images: '{path.name}' exceeds Pillow's decompression-bomb "
            f"limit ({Image.MAX_IMAGE_PIXELS:,} px). Resize it before stitching."
        ) from exc
    except (OSError, ValueError) as exc:
        if isinstance(exc, ValueError) and str(exc).startswith("Multi Stitch Images:"):
            raise
        raise ValueError(
            f"Multi Stitch Images: could not read '{path.name}' ({exc})."
        ) from exc


def _flatten_alpha(image: Image.Image, background: tuple[float, float, float]) -> Image.Image:
    """Composite transparency onto the node background instead of discarding it.

    Dropping the alpha channel with a plain convert("RGB") exposes whatever RGB
    happened to be stored under fully transparent pixels, which is common in
    pasted screenshots and cut-outs.
    """
    if image.mode not in {"RGBA", "LA", "PA"} and "transparency" not in image.info:
        return image.convert("RGB")
    rgba = image.convert("RGBA")
    solid = Image.new("RGBA", rgba.size, tuple(round(c * 255) for c in background) + (255,))
    return Image.alpha_composite(solid, rgba).convert("RGB")


def _exif_orientation(source: Image.Image) -> int:
    """Read orientation without decoding pixels, including late PNG eXIf."""
    if source.format == "TIFF":
        # Pillow's TIFF plugin already publishes the oriented size and applies
        # its orientation during load; transposing again would rotate twice.
        return 1
    try:
        # Bypass PNG's override, whose getexif() calls load(). The base method
        # also supports TIFF tags that are not stored in info["exif"].
        orientation = int(Image.Image.getexif(source).get(_EXIF_ORIENTATION, 1))
        if source.format != "PNG" or source.fp is None:
            return orientation
        stream = source.fp
        position = stream.tell()
        try:
            stream.seek(0, 2)
            file_size = stream.tell()
            stream.seek(8)
            while stream.tell() + 12 <= file_size:
                header = stream.read(8)
                length, kind = int.from_bytes(header[:4], "big"), header[4:]
                if stream.tell() + length + 4 > file_size:
                    raise ValueError("Multi Stitch Images: truncated PNG chunk.")
                if kind == b"eXIf":
                    if length > 1024 * 1024:
                        raise ValueError("Multi Stitch Images: PNG EXIF exceeds 1 MiB.")
                    exif = Image.Exif()
                    exif.load(stream.read(length))
                    orientation = int(exif.get(_EXIF_ORIENTATION, 1))
                    stream.seek(4, 1)
                else:
                    stream.seek(length + 4, 1)
                if kind == b"IEND":
                    break
        finally:
            stream.seek(position)
        return orientation
    except Exception:
        # Pillow raises SyntaxError for a non-TIFF block but struct.error for a
        # truncated one; a malformed EXIF block must not make a decodable image
        # unusable, so treat anything unreadable as "no orientation".
        return 1


def _apply_orientation(image: Image.Image, orientation: int) -> Image.Image:
    method = _ORIENTATION_TRANSPOSES.get(orientation)
    return image.transpose(method) if method is not None else image


def _oriented_size(source: Image.Image) -> tuple[int, int]:
    """Displayed size after EXIF orientation, from the header alone."""
    width, height = source.size
    if _exif_orientation(source) in _ORIENTATIONS_THAT_SWAP_AXES:
        width, height = height, width
    return width, height


def _inspect_item(item: dict) -> tuple[tuple[int, int], tuple[int, int]]:
    """Return ((source_w, source_h), (output_w, output_h)) without decoding pixels.

    The source size is what decoding will cost; the output size is the exact
    post-rotate/crop footprint that lands on the canvas.
    """
    path = _safe_input_path(item)
    with _open_image(path) as source:
        width, height = _oriented_size(source)
    source_size = (width, height)

    rotation, _, _ = _normalize_transform(item)
    if rotation in {90, 270}:
        width, height = height, width

    left, top, right, bottom = _crop_box(width, height, item.get("crop"))
    return source_size, (right - left, bottom - top)


def _item_output_dimensions(item: dict) -> tuple[int, int]:
    """Exact post-EXIF/rotate/crop dimensions without decoding to a tensor."""
    return _inspect_item(item)[1]


def _load_image(
    item: dict,
    background: tuple[float, float, float] = (1.0, 1.0, 1.0),
) -> torch.Tensor:
    path = _safe_input_path(item)
    with _open_image(path) as source:
        image = _apply_orientation(source, _exif_orientation(source))
        image = _flatten_alpha(image, background)
        image = _apply_transform(image, item)
        width, height = image.size
        left, top, right, bottom = _crop_box(width, height, item.get("crop"))

        if (left, top, right, bottom) != (0, 0, width, height):
            image = image.crop((left, top, right, bottom))

        array = np.asarray(image, dtype=np.float32) / 255.0

    return torch.from_numpy(array).unsqueeze(0)


def _resize_exact(image: torch.Tensor, height: int, width: int) -> torch.Tensor:
    if (image.shape[1], image.shape[2]) == (height, width):
        return image
    nchw = image.movedim(-1, 1)
    resized = F.interpolate(nchw, size=(height, width), mode="bicubic", align_corners=False, antialias=True)
    return resized.movedim(1, -1).clamp_(0.0, 1.0)


def _reference_index(
    dimensions: list[tuple[int, int]],
    layout_mode: str,
    direction: str,
    match_reference: str,
) -> int:
    """Which image the others are matched to when match_image_size is on.

    "first" is the list order, as ComfyUI's Stitch Images does. "largest" and
    "smallest" pick by the side the images share in a strip (height when
    horizontal, width when vertical) and by area in a grid; on a tie the
    earlier image wins. The reference keeps its own size, so "smallest" never
    enlarges anything and "largest" never shrinks a strip. Mirrored by
    referenceIndex in web/shared.js.
    """
    match_reference = _require_choice("match_reference", match_reference, _MATCH_REFERENCES)
    if match_reference == "first" or len(dimensions) <= 1:
        return 0
    if layout_mode == "grid":
        keys = [w * h for w, h in dimensions]
    elif direction in {"left", "right"}:
        keys = [h for _, h in dimensions]
    else:
        keys = [w for w, _ in dimensions]
    target = max(keys) if match_reference == "largest" else min(keys)
    return keys.index(target)


def _prepared_strip_dims(
    dimensions: list[tuple[int, int]],
    direction: str,
    match_image_size: bool,
    match_reference: str = "first",
) -> list[tuple[int, int]]:
    """Size of each strip image after match_image_size, in list order.

    Shared by the estimate and the composition, so the canvas measured before
    decoding is the canvas actually filled.
    """
    if not match_image_size or len(dimensions) <= 1:
        return list(dimensions)
    reference = _reference_index(dimensions, "strip", direction, match_reference)
    ref_w, ref_h = dimensions[reference]
    prepared = []
    for index, (w, h) in enumerate(dimensions):
        if index == reference:
            prepared.append((w, h))
        elif direction in {"left", "right"}:
            prepared.append((max(1, int(round(w * (ref_h / h)))), ref_h))
        else:
            prepared.append((ref_w, max(1, int(round(h * (ref_w / w))))))
    return prepared


def _fit_size(width: int, height: int, cell_w: int, cell_h: int) -> tuple[int, int]:
    """Largest size with the same aspect that fits inside a grid cell."""
    scale = min(cell_h / height, cell_w / width)
    return max(1, int(round(width * scale))), max(1, int(round(height * scale)))


def _parse_hex_color(value: str) -> tuple[float, float, float]:
    text = str(value or "").strip()
    match = re.fullmatch(r"#?([0-9a-fA-F]{6})", text)
    if not match:
        short = re.fullmatch(r"#?([0-9a-fA-F]{3})", text)
        if short:
            digits = "".join(ch * 2 for ch in short.group(1))
        else:
            digits = "808080"
    else:
        digits = match.group(1)
    return tuple(int(digits[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def _resolve_color(spacing_color: str, custom_spacing_color: str) -> tuple[float, float, float]:
    if spacing_color == "custom":
        return _parse_hex_color(custom_spacing_color)
    if spacing_color not in _COLOR_MAP:
        raise ValueError(_choice_error("spacing_color", spacing_color, (*_COLOR_MAP, "custom")))
    return _COLOR_MAP[spacing_color]


def _choice_error(name: str, value: object, allowed: tuple[str, ...]) -> str:
    return (
        f"Multi Stitch Images: {name} must be one of "
        f"{', '.join(allowed)}, got {value!r}."
    )


def _require_choice(name: str, value: object, allowed: tuple[str, ...]) -> str:
    """Reject an out-of-range enum instead of quietly substituting a default."""
    if value not in allowed:
        raise ValueError(_choice_error(name, value, allowed))
    return value


def _grid_shape(count: int, grid_columns: int, direction: str) -> tuple[int, int]:
    """Rows and columns the grid actually fills, for a given fill direction.

    ``right``/``left`` fill row by row, so ``grid_columns`` is the column count.
    ``down``/``up`` fill column by column: once ``rows`` is fixed, only
    ``ceil(count / rows)`` columns receive an image, and any extra column would
    be emitted as a band of bare spacing colour (4 images at grid_columns=3).
    """
    count = max(1, int(count))
    cols = max(1, min(int(grid_columns), count))
    rows = math.ceil(count / cols)
    if direction in {"down", "up"}:
        cols = math.ceil(count / rows)
    return rows, cols


Placement = tuple[int, int, int, int]


def _layout(
    dimensions: list[tuple[int, int]],
    layout_mode: str,
    direction: str,
    match_image_size: bool,
    grid_columns: int,
    spacing_width: int,
    grid_cell_width: int = 0,
    grid_cell_height: int = 0,
    match_reference: str = "first",
) -> tuple[int, int, list[Placement]]:
    """Canvas size and the (x, y, w, h) each image occupies, in list order.

    This is the one description of where images go: the pre-decode estimate,
    the streaming composition and the in-node preview (its JavaScript mirror,
    layoutPlacements in web/shared.js) all derive from it.
    """
    if not dimensions:
        raise ValueError("Multi Stitch Images: paste or add at least one image first.")

    direction = _require_choice("direction", direction, _DIRECTIONS)
    layout_mode = _require_choice("layout_mode", layout_mode, _LAYOUT_MODES)
    match_reference = _require_choice("match_reference", match_reference, _MATCH_REFERENCES)
    spacing_width = max(0, int(spacing_width))
    dims = [(max(1, int(w)), max(1, int(h))) for w, h in dimensions]

    if layout_mode == "grid":
        rows, cols = _grid_shape(len(dims), grid_columns, direction)
        cell_w = max(0, int(grid_cell_width))
        cell_h = max(0, int(grid_cell_height))
        if cell_w > 0 and cell_h > 0:
            # An explicit cell: every image is fitted into it, never stretched.
            placed = [_fit_size(w, h, cell_w, cell_h) for w, h in dims]
        elif match_image_size:
            cell_w, cell_h = dims[_reference_index(dims, "grid", direction, match_reference)]
            placed = [_fit_size(w, h, cell_w, cell_h) for w, h in dims]
        else:
            cell_w = max(w for w, _ in dims)
            cell_h = max(h for _, h in dims)
            placed = list(dims)

        placements: list[Placement] = []
        for index, (w, h) in enumerate(placed):
            row, col = _grid_position(index, rows, cols, direction)
            x = col * (cell_w + spacing_width) + (cell_w - w) // 2
            y = row * (cell_h + spacing_width) + (cell_h - h) // 2
            placements.append((x, y, w, h))
        return (
            cols * cell_w + spacing_width * (cols - 1),
            rows * cell_h + spacing_width * (rows - 1),
            placements,
        )

    prepared = _prepared_strip_dims(dims, direction, match_image_size, match_reference)
    order = list(range(len(prepared)))
    if direction in {"left", "up"}:
        order.reverse()
    horizontal = direction in {"left", "right"}
    if horizontal:
        out_h = max(h for _, h in prepared)
        out_w = sum(w for w, _ in prepared) + spacing_width * (len(prepared) - 1)
    else:
        out_w = max(w for w, _ in prepared)
        out_h = sum(h for _, h in prepared) + spacing_width * (len(prepared) - 1)

    strip: list[Placement] = [(0, 0, 0, 0)] * len(prepared)
    cursor = 0
    for index in order:
        w, h = prepared[index]
        if horizontal:
            strip[index] = (cursor, (out_h - h) // 2, w, h)
            cursor += w + spacing_width
        else:
            strip[index] = ((out_w - w) // 2, cursor, w, h)
            cursor += h + spacing_width
    return out_w, out_h, strip


def _estimate_output_dimensions(
    dimensions: list[tuple[int, int]],
    layout_mode: str,
    direction: str,
    match_image_size: bool,
    grid_columns: int,
    spacing_width: int,
    grid_cell_width: int = 0,
    grid_cell_height: int = 0,
    match_reference: str = "first",
) -> tuple[int, int]:
    """Exact canvas size, from the same layout the composition fills."""
    out_w, out_h, _ = _layout(
        dimensions, layout_mode, direction, match_image_size,
        grid_columns, spacing_width, grid_cell_width, grid_cell_height,
        match_reference=match_reference,
    )
    return out_w, out_h


def _limited_size(width: int, height: int, output_limit: str, output_limit_px: int) -> tuple[int, int]:
    """Final size after the optional output cap. Only ever shrinks."""
    output_limit = _require_choice("output_limit", output_limit, _OUTPUT_LIMITS)
    if output_limit == "none":
        return width, height
    limit = max(1, int(output_limit_px))
    current = {
        "max_width": width,
        "max_height": height,
        "max_long_side": max(width, height),
    }[output_limit]
    if current <= limit:
        return width, height
    scale = limit / current
    return max(1, int(round(width * scale))), max(1, int(round(height * scale)))


def _validate_output_dimensions(width: int, height: int) -> None:
    pixels = int(width) * int(height)
    if width <= _MAX_OUTPUT_SIDE and height <= _MAX_OUTPUT_SIDE and pixels <= _MAX_OUTPUT_PIXELS:
        return

    megapixels = pixels / 1_000_000
    approx_gib = pixels * 3 * 4 / (1024 ** 3)
    limit_mp = _MAX_OUTPUT_PIXELS / 1_000_000
    raise ValueError(
        "Multi Stitch Images: estimated output "
        f"{width:,} × {height:,} ({megapixels:.1f} MP, ~{approx_gib:.2f} GiB float32) "
        f"exceeds the safety limit ({limit_mp:.1f} MP / {_MAX_OUTPUT_SIDE:,} px per side). "
        "Reduce image count, crop/resize the sources, use Grid, or enable match_image_size."
    )


def _validate_source_pixels(item: dict, width: int, height: int) -> None:
    """Bound one original as it will be decoded, whatever crop follows.

    A crop shrinks what lands on the canvas, not what must be decoded and
    transformed first, so this looks at the full oriented source size.
    """
    pixels = int(width) * int(height)
    if pixels <= _MAX_SOURCE_PIXELS:
        return

    megapixels = pixels / 1_000_000
    limit_mp = _MAX_SOURCE_PIXELS / 1_000_000
    raise ValueError(
        f"Multi Stitch Images: '{item.get('filename', '?')}' is "
        f"{width:,} × {height:,} ({megapixels:.1f} MP), above the per-image "
        f"limit of {limit_mp:.1f} MP. Resize it before adding it to the node."
    )


Loader = Callable[[], torch.Tensor]


def _blank_canvas(width: int, height: int, color_tuple: tuple[float, float, float]) -> torch.Tensor:
    color = torch.tensor(color_tuple, dtype=torch.float32)
    return color.view(1, 1, 1, 3).expand(1, height, width, 3).clone()


def _load_checked(loader: Loader, expected: tuple[int, int], index: int) -> torch.Tensor:
    """Decode one source and make a measurement mismatch a clear error."""
    image = loader()
    width, height = expected
    if image.dim() != 4 or image.shape[1] != height or image.shape[2] != width:
        got = "×".join(str(v) for v in tuple(image.shape))
        raise ValueError(
            f"Multi Stitch Images: image {index + 1} decoded to {got} but was "
            f"measured as {width}×{height}×3; the file changed while stitching."
        )
    return image


def _grid_position(index: int, rows: int, cols: int, direction: str) -> tuple[int, int]:
    if direction == "left":
        row, col = divmod(index, cols)
        return row, cols - 1 - col
    if direction in {"down", "up"}:
        col, row = divmod(index, rows)
        if direction == "up":
            row = rows - 1 - row
        return row, col
    return divmod(index, cols)


def _validate_cells_output(count: int, cell_w: int, cell_h: int) -> None:
    pixels = count * cell_w * cell_h
    if pixels <= _MAX_OUTPUT_PIXELS:
        return
    raise ValueError(
        f"Multi Stitch Images: the cells output would be {count} × {cell_w:,} × {cell_h:,} "
        f"({pixels / 1_000_000:.1f} MP, ~{pixels * 3 * 4 / (1024 ** 3):.2f} GiB float32), "
        f"above the safety limit ({_MAX_OUTPUT_PIXELS / 1_000_000:.1f} MP). "
        "Turn off output_cells, or reduce the image count or cell size."
    )


def _compose_from(
    loaders: list[Loader],
    dimensions: list[tuple[int, int]],
    layout_mode: str,
    direction: str,
    match_image_size: bool,
    grid_columns: int,
    spacing_width: int,
    spacing_color: str,
    custom_spacing_color: str,
    grid_cell_width: int = 0,
    grid_cell_height: int = 0,
    output_limit: str = "none",
    output_limit_px: int = 2048,
    output_cells: bool = False,
    cells_resolution: str = "placed",
    minimum_image_side: int = 0,
    match_reference: str = "first",
) -> tuple[torch.Tensor, torch.Tensor]:
    """Compose from lazy sources: each loader is called once, in list order.

    Returns (image, cells). `image` is the stitched canvas, optionally scaled
    down by output_limit. `cells` is a batch with one frame per source, each
    centred in a uniform cell on the background colour — or, when
    output_cells is off, the image itself, so the output is never empty.
    Validation happens before any loader runs. Every tensor is CPU float32
    [N, H, W, 3] as ComfyUI expects.
    """
    if not loaders:
        raise ValueError("Multi Stitch Images: paste or add at least one image first.")
    if len(loaders) != len(dimensions):
        raise ValueError("Multi Stitch Images: internal error, one measurement per image is required.")

    color_tuple = _resolve_color(spacing_color, custom_spacing_color)
    out_w, out_h, placements = _layout(
        dimensions, layout_mode, direction, match_image_size,
        grid_columns, spacing_width, grid_cell_width, grid_cell_height,
        match_reference=match_reference,
    )
    _validate_output_dimensions(out_w, out_h)
    final_w, final_h = _limited_size(out_w, out_h, output_limit, output_limit_px)

    _require_choice("cells_resolution", cells_resolution, ("placed", "source"))
    if not isinstance(minimum_image_side, int) or not 0 <= minimum_image_side <= _MAX_OUTPUT_SIDE:
        raise ValueError("Multi Stitch Images: minimum_image_side must be an integer between 0 and 131072.")
    if minimum_image_side and any(min(w * final_w / out_w, h * final_h / out_h) < minimum_image_side for x, y, w, h in placements):
        raise ValueError("Multi Stitch Images: a placed image is below minimum_image_side. Increase output size, disable size matching, or lower the minimum.")
    cells = None
    if output_cells:
        cell_w = max(w for w, h in dimensions) if cells_resolution == "source" else max(w for _, _, w, _ in placements)
        cell_h = max(h for w, h in dimensions) if cells_resolution == "source" else max(h for _, _, _, h in placements)
        _validate_cells_output(len(placements), cell_w, cell_h)
        color = torch.tensor(color_tuple, dtype=torch.float32)
        cells = color.view(1, 1, 1, 3).expand(len(placements), cell_h, cell_w, 3).clone()

    # The canvas starts filled with the background colour, which is what makes
    # separator bars and letterbox padding that colour in either layout.
    output = _blank_canvas(out_w, out_h, color_tuple)
    for index, (loader, (x, y, w, h)) in enumerate(zip(loaders, placements)):
        source = _load_checked(loader, dimensions[index], index).to(output)
        image = _resize_exact(source, h, w)
        output[:, y:y + h, x:x + w, :] = image
        if cells is not None:
            cell_image = source if cells_resolution == "source" else image
            cell_h, cell_w = cell_image.shape[1:3]
            cx = (cells.shape[2] - cell_w) // 2
            cy = (cells.shape[1] - cell_h) // 2
            cells[index:index + 1, cy:cy + cell_h, cx:cx + cell_w, :] = cell_image
            del cell_image
        del source, image  # release this source before the next one is decoded

    if (final_w, final_h) != (out_w, out_h):
        output = _resize_exact(output, final_h, final_w)
    return output, (cells if cells is not None else output)


def _compose(
    images: list[torch.Tensor],
    layout_mode: str,
    direction: str,
    match_image_size: bool,
    grid_columns: int,
    spacing_width: int,
    spacing_color: str,
    custom_spacing_color: str,
    **options,
) -> torch.Tensor:
    """Compose already-decoded tensors; the same path stitch() streams through."""
    dimensions = [(int(img.shape[2]), int(img.shape[1])) for img in images]
    loaders: list[Loader] = [functools.partial(lambda tensor: tensor, img) for img in images]
    image, _ = _compose_from(
        loaders,
        dimensions,
        layout_mode,
        direction,
        match_image_size,
        grid_columns,
        spacing_width,
        spacing_color,
        custom_spacing_color,
        **options,
    )
    return image


def _frame_loader(frame: torch.Tensor, background: tuple[float, float, float]) -> tuple[Loader, tuple[int, int]]:
    """Validate shape now; convert and composite only when streaming this frame."""
    if frame.dim() != 3 or frame.shape[0] < 1 or frame.shape[1] < 1:
        raise ValueError(f"Multi Stitch Images: the IMAGE input must be [batch, height, width, channels], got {tuple(frame.shape)}.")
    channels = frame.shape[-1]
    if channels not in (1, 3, 4):
        raise ValueError(f"Multi Stitch Images: the IMAGE input has {channels} channels; expected 1, 3 or 4.")
    size = int(frame.shape[1]), int(frame.shape[0])
    _validate_source_pixels({"filename": "IMAGE input"}, *size)
    def load():
        tensor = frame.detach().unsqueeze(0).to(device="cpu", dtype=torch.float32)
        if channels == 4:
            alpha = tensor[..., 3:4]
            colour = torch.tensor(background, dtype=tensor.dtype).view(1, 1, 1, 3)
            tensor = tensor[..., :3] * alpha + colour * (1.0 - alpha)
        elif channels == 1:
            tensor = tensor.expand(-1, -1, -1, 3)
        return tensor
    return load, size


class MultiStitchImages:
    """Paste many images into one node, edit each one, then stitch or arrange as a grid."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # Keep the first five widgets in the original v1 order so older
                # saved workflows load without widget-value shifting.
                "direction": (["right", "down", "left", "up"], {
                    "default": "right",
                    "tooltip": "Strip: where each next image goes. Grid: the fill order — "
                               "right/left fill row by row, down/up fill column by column.",
                }),
                "match_image_size": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Scale every image to the reference image (match_reference, the first by default): "
                               "its height (or width) in a strip, fitted inside its cell in a grid. "
                               "Off keeps each image at its own size.",
                }),
                "spacing_width": ("INT", {
                    "default": 0, "min": 0, "max": 1024, "step": 2,
                    "tooltip": "Gap between images in pixels, filled with spacing_color. Odd values work too.",
                }),
                "spacing_color": (["white", "black", "red", "green", "blue", "custom"], {
                    "default": "white",
                    "tooltip": "Colour of the gaps and of any letterbox area around a smaller image. "
                               "custom uses custom_spacing_color.",
                }),
                "images_json": ("STRING", {
                    "default": "[]", "multiline": True,
                    "tooltip": "The pasted image list with each crop, rotation and flip. "
                               "Managed by the node's own UI and hidden.",
                }),
                "layout_mode": (["strip", "grid"], {
                    "default": "strip",
                    "tooltip": "strip: one row or one column. grid: rows and columns, grid_columns wide.",
                }),
                "grid_columns": ("INT", {
                    "default": 3, "min": 1, "max": 16, "step": 1,
                    "tooltip": "Number of columns in grid mode. The rows follow from the image count.",
                }),
                "custom_spacing_color": ("STRING", {
                    "default": "#808080",
                    "tooltip": "Hex colour (#RRGGBB) used when spacing_color is custom. "
                               "Pick it with the colour button on the node.",
                }),
                # Later additions stay after the original widgets so saved
                # workflows keep their widget values aligned; defaults reproduce
                # the previous behaviour exactly.
                "output_limit": (list(_OUTPUT_LIMITS), {
                    "default": "none",
                    "tooltip": "Scale the finished result down so its width, height or long side is at most "
                               "output_limit_px. Never scales up. none keeps the native size.",
                }),
                "output_limit_px": ("INT", {
                    "default": 2048, "min": 64, "max": 16384, "step": 8,
                    "tooltip": "Pixel cap used by output_limit.",
                }),
                "grid_cell_width": ("INT", {
                    "default": 0, "min": 0, "max": 16384, "step": 8,
                    "tooltip": "Grid only: fixed cell width in pixels; every image is fitted inside the cell, "
                               "never stretched. 0 sizes the cells from the largest image.",
                }),
                "grid_cell_height": ("INT", {
                    "default": 0, "min": 0, "max": 16384, "step": 8,
                    "tooltip": "Grid only: fixed cell height in pixels; every image is fitted inside the cell, "
                               "never stretched. 0 sizes the cells from the largest image.",
                }),
                "output_cells": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Also fill the cells output with one frame per image, each centred in a uniform "
                               "cell, for using the references separately. Off: cells repeats the stitched image.",
                }),
            },
            "optional": {
                # Frames from a connected batch are appended after the pasted
                # images, so a generated or upscaled result can be stitched
                # without saving and re-adding it.
                "images": ("IMAGE", {
                    "tooltip": "Optional IMAGE batch appended after the pasted images, so a generated result "
                               "can be stitched without saving it first.",
                }),
                "cells_resolution": (["placed", "source"], {
                    "default": "placed",
                    "tooltip": "placed: each cell at the size the image has in the stitched result. "
                               "source: at the original cropped size, unscaled.",
                }),
                "minimum_image_side": ("INT", {
                    "default": 0, "min": 0, "max": 131072,
                    "tooltip": "Stop before decoding if any placed image's short side would be smaller than "
                               "this many pixels. 0 turns the check off.",
                }),
                # Added after 1.1: last, so every earlier widget keeps its slot
                # in saved workflows. Shown by the UI only while
                # match_image_size is on.
                "match_reference": (list(_MATCH_REFERENCES), {
                    "default": "first",
                    "tooltip": "Which image the others are scaled to when match_image_size is on. first: the "
                               "first in the list. largest / smallest: the tallest or shortest image in a "
                               "horizontal strip (widest or narrowest in a vertical one), the largest or "
                               "smallest by area in a grid. The reference keeps its own size, so smallest "
                               "never enlarges anything.",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("image", "cells")
    FUNCTION = "stitch"
    CATEGORY = "image/transform"
    DESCRIPTION = (
        "Paste multiple images directly into this node with Ctrl+V, click an image to edit, "
        "drag its ≡ handle to reorder, then output a strip or grid."
    )
    OUTPUT_TOOLTIPS = (
        "The stitched strip or grid.",
        "One frame per image, centred in a uniform cell, when output_cells is on; "
        "otherwise the stitched image again.",
    )

    def stitch(
        self,
        direction,
        match_image_size,
        spacing_width,
        spacing_color,
        images_json,
        layout_mode,
        grid_columns,
        custom_spacing_color,
        output_limit="none",
        output_limit_px=2048,
        grid_cell_width=0,
        grid_cell_height=0,
        output_cells=False,
        images=None,
        cells_resolution="placed",
        minimum_image_side=0,
        match_reference="first",
    ):
        try:
            items = json.loads(images_json or "[]")
        except json.JSONDecodeError as exc:
            raise ValueError("Multi Stitch Images: corrupted image list in workflow.") from exc

        if not isinstance(items, list):
            raise ValueError("Multi Stitch Images: image list must be an array.")
        valid_items = [item for item in items if isinstance(item, dict)]
        if images is not None and (images.dim() != 4 or images.shape[0] < 1):
            raise ValueError("Multi Stitch Images: the IMAGE input must be a nonempty [batch, height, width, channels] tensor.")
        frames = list(images) if images is not None else []
        if len(valid_items) + len(frames) > _MAX_IMAGES:
            raise ValueError(
                f"Multi Stitch Images: maximum {_MAX_IMAGES} images per node "
                f"({len(valid_items)} pasted + {len(frames)} from the IMAGE input)."
            )

        # Header-only pass: measure every source and its footprint on the
        # canvas, and refuse an original that would be too big to decode.
        background = _resolve_color(spacing_color, custom_spacing_color)
        dimensions: list[tuple[int, int]] = []
        loaders: list[Loader] = []
        for item in valid_items:
            (source_w, source_h), output_size = _inspect_item(item)
            _validate_source_pixels(item, source_w, source_h)
            dimensions.append(output_size)
            loaders.append(functools.partial(_load_image, item, background))
        for frame in frames:
            loader, size = _frame_loader(frame, background)
            loaders.append(loader)
            dimensions.append(size)

        # Decode pass: _compose_from validates the canvas first, then pulls
        # each source through its loader one at a time.
        return _compose_from(
            loaders,
            dimensions,
            layout_mode,
            direction,
            match_image_size,
            grid_columns,
            spacing_width,
            spacing_color,
            custom_spacing_color,
            grid_cell_width=grid_cell_width,
            grid_cell_height=grid_cell_height,
            output_limit=output_limit,
            output_limit_px=output_limit_px,
            output_cells=output_cells,
            cells_resolution=cells_resolution,
            minimum_image_side=minimum_image_side,
            match_reference=match_reference,
        )

    @classmethod
    def IS_CHANGED(cls, images_json="[]", **kwargs):
        try:
            entries = json.loads(images_json or "[]")
            fingerprints = []
            for item in entries:
                if not isinstance(item, dict):
                    continue
                path = _safe_input_path(item)
                stat = path.stat()
                fingerprints.append((str(path), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))
            return hashlib.sha256(repr(fingerprints).encode()).hexdigest()
        except (ValueError, TypeError, OSError, AttributeError):
            return float("nan")


NODE_CLASS_MAPPINGS = {
    "MultiStitchImages": MultiStitchImages,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MultiStitchImages": "Multi Stitch Images",
}
