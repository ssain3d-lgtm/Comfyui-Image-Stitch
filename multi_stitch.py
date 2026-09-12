import asyncio
import functools
import hashlib
import io
import json
import math
import os
import re
import secrets
import sys
import time
from collections.abc import Callable
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

import folder_paths

try:
    from . import multi_stitch_gallery as gallery
except ImportError:  # loaded as a plain module by tests and tooling
    if "multi_stitch_gallery" in sys.modules:
        gallery = sys.modules["multi_stitch_gallery"]
    else:
        import importlib.util as _importlib_util

        _gallery_spec = _importlib_util.spec_from_file_location(
            "multi_stitch_gallery", Path(__file__).resolve().with_name("multi_stitch_gallery.py"),
        )
        gallery = _importlib_util.module_from_spec(_gallery_spec)
        # Registered before it is executed, so a second load of this file finds
        # the same module instead of building a rival copy of the gallery.
        sys.modules["multi_stitch_gallery"] = gallery
        _gallery_spec.loader.exec_module(gallery)


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
# A quarter turn clockwise in the displayed coordinate system, which is the
# opposite direction to Pillow's own naming.
_ROTATION_TRANSPOSES = {
    90: Image.Transpose.ROTATE_270,
    180: Image.Transpose.ROTATE_180,
    270: Image.Transpose.ROTATE_90,
}
_TRANSPOSES_THAT_SWAP_AXES = {
    Image.Transpose.ROTATE_90,
    Image.Transpose.ROTATE_270,
    Image.Transpose.TRANSPOSE,
    Image.Transpose.TRANSVERSE,
}
# Every transpose is its own inverse except the two quarter turns.
_TRANSPOSE_INVERSES = {
    Image.Transpose.ROTATE_90: Image.Transpose.ROTATE_270,
    Image.Transpose.ROTATE_270: Image.Transpose.ROTATE_90,
}
# Sample widths convert("RGB") cannot carry: it keeps the low 8 bits, so a
# mid-grey 16-bit image comes out solid white. The value is the range the mode
# is meant to hold; a file that exceeds it is normalised by its own maximum.
_HIGH_DEPTH_RANGES = {
    "I;16": 65535.0,
    "I;16B": 65535.0,
    "I;16L": 65535.0,
    "I;16N": 65535.0,
    "I": 65535.0,   # where a 16-bit PNG lands on older Pillow versions
    "F": 1.0,
}

_DIRECTIONS = ("right", "down", "left", "up")
_LAYOUT_MODES = ("strip", "grid")
_MATCH_REFERENCES = ("first", "largest", "smallest")
# New nodes match to the smallest image, so nothing is ever upscaled. A prompt
# that omits the value — one written before the option existed — keeps "first",
# the behaviour it had then, which is why stitch() defaults differently.
_DEFAULT_MATCH_REFERENCE = "smallest"
_LEGACY_MATCH_REFERENCE = "first"
# Which image the width/height outputs describe. The superlatives go by area,
# unlike match_reference, which goes by the side a strip shares.
# size_reference is an image number, 1 = the first in the list. The names the
# option briefly used are still understood, so nothing saved with them breaks.
_LEGACY_SIZE_REFERENCES = ("first", "largest", "smallest")
_OUTPUT_LIMITS = ("none", "max_width", "max_height", "max_long_side")


_DRIVE_LETTER = re.compile(r"^[A-Za-z]:")


def _item_relative_path(item: dict) -> str:
    """The item's own `subfolder/filename`, checked but never resolved.

    The same lexical rules ComfyUI applies to an upload: no absolute path, no
    drive letter, no `..` and no NUL byte. Symlinks are deliberately left
    alone, so a subfolder of `input/` that links somewhere else keeps working,
    as it does for ComfyUI's own Load Image.
    """
    filename = str(item.get("filename", "")).strip()
    subfolder = str(item.get("subfolder", "")).strip()

    if not filename:
        raise ValueError("Multi Stitch Images: image entry has no filename.")
    text = f"{subfolder}/{filename}" if subfolder else filename
    text = text.replace("\\", "/")
    if "\x00" in text:
        raise ValueError(f"Multi Stitch Images: unsafe image path rejected: {text!r}")
    segments = [segment for segment in text.split("/") if segment not in {"", "."}]
    unsafe = (
        text.startswith("/")
        or _DRIVE_LETTER.match(text) is not None
        or not segments
        or ".." in segments
    )
    if unsafe:
        raise ValueError(f"Multi Stitch Images: unsafe image path rejected: {text!r}")
    return "/".join(segments)


def _safe_input_path(item: dict) -> Path:
    """Resolve an uploaded ComfyUI input image without allowing path traversal."""
    item_type = str(item.get("type", "input")).strip().lower()
    if item_type not in {"input", "temp"}:
        raise ValueError(f"Multi Stitch Images: unsupported image type: {item_type}")

    relative = _item_relative_path(item)
    directory = folder_paths.get_input_directory() if item_type == "input" else folder_paths.get_temp_directory()
    # Normalised lexically, symlinks untouched: `..` is already refused above,
    # so the join cannot leave the folder, and the check says so out loud.
    base = os.path.abspath(directory)
    candidate = os.path.abspath(os.path.join(base, *relative.split("/")))
    if os.path.commonpath((base, candidate)) != base:
        raise ValueError(f"Multi Stitch Images: unsafe image path rejected: {relative!r}")

    path = Path(candidate)
    if not path.is_file():
        # The server's own folder layout is nothing the user can act on, so the
        # error names the item as the node's list holds it.
        raise FileNotFoundError(f"Multi Stitch Images: image not found: {relative}")
    return path


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


def _transform_methods(item: dict) -> list[Image.Transpose]:
    """The transposes the item asks for: rotate first, then flip."""
    rotation, flip_h, flip_v = _normalize_transform(item)
    methods = []
    if rotation in _ROTATION_TRANSPOSES:
        methods.append(_ROTATION_TRANSPOSES[rotation])
    if flip_h:
        methods.append(Image.Transpose.FLIP_LEFT_RIGHT)
    if flip_v:
        methods.append(Image.Transpose.FLIP_TOP_BOTTOM)
    return methods


def _apply_transform(image: Image.Image, item: dict) -> Image.Image:
    """Rotate first, then flip in the displayed/output coordinate system."""
    for method in _transform_methods(item):
        image = image.transpose(method)
    return image


def _transformed_size(size: tuple[int, int], methods: list[Image.Transpose]) -> tuple[int, int]:
    """The size an image of `size` has once `methods` have been applied."""
    width, height = size
    for method in methods:
        if method in _TRANSPOSES_THAT_SWAP_AXES:
            width, height = height, width
    return width, height


def _transposed_point(x: int, y: int, width: int, height: int, method: Image.Transpose) -> tuple[int, int]:
    """Where pixel (x, y) of a (width, height) image lands after `method`."""
    if method == Image.Transpose.FLIP_LEFT_RIGHT:
        return width - 1 - x, y
    if method == Image.Transpose.FLIP_TOP_BOTTOM:
        return x, height - 1 - y
    if method == Image.Transpose.ROTATE_90:
        return y, width - 1 - x
    if method == Image.Transpose.ROTATE_180:
        return width - 1 - x, height - 1 - y
    if method == Image.Transpose.ROTATE_270:
        return height - 1 - y, x
    if method == Image.Transpose.TRANSPOSE:
        return y, x
    if method == Image.Transpose.TRANSVERSE:
        return height - 1 - y, width - 1 - x
    return x, y


def _transposed_box(
    box: tuple[int, int, int, int],
    width: int,
    height: int,
    method: Image.Transpose,
) -> tuple[int, int, int, int]:
    """Where a pixel box of a (width, height) image lands after `method`."""
    left, top, right, bottom = box
    x0, y0 = _transposed_point(left, top, width, height, method)
    x1, y1 = _transposed_point(right - 1, bottom - 1, width, height, method)
    return min(x0, x1), min(y0, y1), max(x0, x1) + 1, max(y0, y1) + 1


def _source_crop_box(
    size: tuple[int, int],
    methods: list[Image.Transpose],
    box: tuple[int, int, int, int],
) -> tuple[int, int, int, int]:
    """The box of the decoded source that `box` in the transformed view covers.

    The exact inverse of the EXIF orientation, the quarter turns and the flips,
    walked back one transpose at a time. Each of them maps a rectangle onto a
    rectangle, so cropping the source first and transforming the small crop
    selects the very same pixels as transforming everything and cropping last.
    """
    spaces = [size]
    for method in methods:
        spaces.append(_transformed_size(spaces[-1], [method]))
    for method, (width, height) in zip(reversed(methods), reversed(spaces[1:]), strict=True):
        box = _transposed_box(box, width, height, _TRANSPOSE_INVERSES.get(method, method))
    return box


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
        return image if image.mode == "RGB" else image.convert("RGB")
    rgba = image.convert("RGBA")
    solid = Image.new("RGBA", rgba.size, tuple(round(c * 255) for c in background) + (255,))
    return Image.alpha_composite(solid, rgba).convert("RGB")


def _high_depth_array(image: Image.Image) -> np.ndarray | None:
    """A grey image with more than 8 bits per sample as float32 [H, W, 3], else None.

    convert("RGB") keeps only the low 8 bits of a 16-bit, 32-bit integer or
    float sample, which turns a mid-grey 16-bit PNG or TIFF solid white. Scale
    by the range the mode is meant to hold instead and stack the one channel to
    RGB. A file that carries more than that range — an "I" image above 65535,
    an "F" image above 1.0 — is normalised by the largest value among the
    pixels that are actually used. Every ordinary mode returns None and is left
    to the alpha flattening above.
    """
    full_range = _HIGH_DEPTH_RANGES.get(image.mode)
    if full_range is None:
        return None
    array = np.array(image, dtype=np.float32)
    if array.size:
        array /= max(full_range, float(array.max()))
    np.clip(array, 0.0, 1.0, out=array)
    return np.repeat(array[:, :, np.newaxis], 3, axis=2)


def _image_array(image: Image.Image, background: tuple[float, float, float]) -> np.ndarray:
    """One decoded image as a float32 [H, W, 3] array in 0..1.

    The scaling divides in place: a separate float32 copy of the same array
    doubles the peak cost of a large source for nothing.
    """
    array = _high_depth_array(image)
    if array is None:
        array = np.array(_flatten_alpha(image, background), dtype=np.float32)
        array /= 255.0
    return array


def _exif_orientation(source: Image.Image) -> int:
    """Read orientation without decoding pixels, including late PNG eXIf."""
    if source.format == "TIFF":
        # Pillow's TIFF plugin applies the orientation itself while loading, so
        # transposing again would rotate twice. What the versions disagree on is
        # only the size before the load, which _decoded_size settles.
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


def _orientation_methods(orientation: int) -> list[Image.Transpose]:
    """The transpose an EXIF orientation asks for, as a list (empty for 1)."""
    method = _ORIENTATION_TRANSPOSES.get(orientation)
    return [method] if method is not None else []


def _decoded_size(source: Image.Image) -> tuple[int, int]:
    """The size the decoded image will have, before the node's own transposes.

    Pillow's TIFF plugin turns the picture for the file's orientation as it
    loads. From 11.0.0 it publishes the turned size the moment the file is
    opened; up to 10.x the header still reports the size as stored and only the
    load swaps it, which made the measured size and the decoded size disagree
    ("the file changed while stitching"). The stored width and height say which
    of the two this Pillow does.
    """
    width, height = source.size
    if source.format != "TIFF":
        return width, height
    try:
        stored = (int(source.tag_v2[256]), int(source.tag_v2[257]))
        orientation = int(source.tag_v2.get(_EXIF_ORIENTATION, 1))
    except (AttributeError, KeyError, TypeError, ValueError):
        return width, height
    if orientation in _ORIENTATIONS_THAT_SWAP_AXES and (width, height) == stored:
        return height, width
    return width, height


def _oriented_size(source: Image.Image) -> tuple[int, int]:
    """Displayed size after EXIF orientation, from the header alone."""
    return _transformed_size(_decoded_size(source), _orientation_methods(_exif_orientation(source)))


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
    """One source as the [1, H, W, 3] float32 tensor the canvas is filled from.

    The crop is measured in the displayed coordinate system, exactly as the
    frontend and the estimate measure it, then mapped back into the source and
    applied first: a small crop of a large original never materialises a
    full-size rotated, flattened or flipped copy of it.
    """
    path = _safe_input_path(item)
    with _open_image(path) as source:
        methods = _orientation_methods(_exif_orientation(source)) + _transform_methods(item)
        source_size = _decoded_size(source)
        width, height = _transformed_size(source_size, methods)
        box = _crop_box(width, height, item.get("crop"))

        image = source
        if box != (0, 0, width, height):
            image = source.crop(_source_crop_box(source_size, methods, box))
        for method in methods:
            image = image.transpose(method)
        array = _image_array(image, background)

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


def _size_reference_index(dimensions: list[tuple[int, int]], size_reference: object) -> int:
    """The list index size_reference names: an image number counted from 1,
    clamped to the list, so a number past the end means the last image (and
    0 or less the first). The names the option briefly used are still
    understood: first, or the largest / smallest by area, an earlier image
    winning a tie. Mirrored by sizeReferenceIndex in web/shared.js.
    """
    if not dimensions:
        raise ValueError("Multi Stitch Images: paste or add at least one image first.")
    name = size_reference.strip().lower() if isinstance(size_reference, str) else ""
    if name in _LEGACY_SIZE_REFERENCES:
        if name == "first":
            return 0
        areas = [w * h for w, h in dimensions]
        target = max(areas) if name == "largest" else min(areas)
        return areas.index(target)
    try:
        number = int(size_reference)
    except (TypeError, ValueError):
        raise ValueError(
            f"Multi Stitch Images: size_reference must be an image number (1 = first), got {size_reference!r}."
        ) from None
    return min(max(1, number), len(dimensions)) - 1


def _reference_size(
    dimensions: list[tuple[int, int]],
    size_reference: object,
    megapixels: float,
    divisible_by: int,
) -> tuple[int, int]:
    """Width and height derived from one image of the list: that image's own
    size, optionally rescaled to a megapixel target, snapped to a multiple.

    size_reference picks the image by number (see _size_reference_index). A
    megapixel target above zero scales both sides by one factor, so the
    aspect ratio survives; each side is then rounded to the nearest multiple
    of divisible_by with Python's round (half to even, which the JavaScript
    mirror reproduces) and never drops below one multiple.
    """
    index = _size_reference_index(dimensions, size_reference)
    width, height = float(dimensions[index][0]), float(dimensions[index][1])
    megapixels = float(megapixels or 0)
    if megapixels > 0:
        scale = math.sqrt(megapixels * 1_000_000 / (width * height))
        width, height = width * scale, height * scale
    step = max(1, int(divisible_by or 1))
    return (
        max(step, int(round(width / step)) * step),
        max(step, int(round(height / step)) * step),
    )


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


def _scaled_side(side: int, scale: float) -> int:
    """One side scaled by the output limit's factor, rounded the way
    _limited_size rounds (half to even) and never below one pixel."""
    if scale == 1.0:
        return int(side)
    return max(1, int(round(side * scale)))


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
    # How much the output limit shrinks the finished canvas, per axis. A placed
    # cell is "the size the image has in the stitched result", so it follows.
    scale_x, scale_y = final_w / out_w, final_h / out_h
    if minimum_image_side and any(min(w * scale_x, h * scale_y) < minimum_image_side for _, _, w, h in placements):
        raise ValueError("Multi Stitch Images: a placed image is below minimum_image_side. Increase output size, disable size matching, or lower the minimum.")
    cells = None
    if output_cells:
        if cells_resolution == "source":
            cell_w = max(w for w, _ in dimensions)
            cell_h = max(h for _, h in dimensions)
        else:
            cell_w = _scaled_side(max(w for _, _, w, _ in placements), scale_x)
            cell_h = _scaled_side(max(h for _, _, _, h in placements), scale_y)
        _validate_cells_output(len(placements), cell_w, cell_h)
        color = torch.tensor(color_tuple, dtype=torch.float32)
        cells = color.view(1, 1, 1, 3).expand(len(placements), cell_h, cell_w, 3).clone()

    # The canvas starts filled with the background colour, which is what makes
    # separator bars and letterbox padding that colour in either layout.
    output = _blank_canvas(out_w, out_h, color_tuple)
    for index, (loader, (x, y, w, h)) in enumerate(zip(loaders, placements, strict=True)):
        source = _load_checked(loader, dimensions[index], index).to(output)
        image = _resize_exact(source, h, w)
        output[:, y:y + h, x:x + w, :] = image
        if cells is not None:
            if cells_resolution == "source":
                cell_image = source
            elif (scale_x, scale_y) == (1.0, 1.0):
                cell_image = image
            else:
                # Straight from the source, so the cell is resampled once.
                cell_image = _resize_exact(source, _scaled_side(h, scale_y), _scaled_side(w, scale_x))
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
                    "default": True,
                    "tooltip": "Scale every image to the reference image (match_reference, the smallest by "
                               "default): its height (or width) in a strip, fitted inside its cell in a grid. "
                               "Off keeps each image at its own size.",
                }),
                "spacing_width": ("INT", {
                    "default": 0, "min": 0, "max": 1024, "step": 1,
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
                # in saved workflows. The UI keeps it under Options, and only
                # while match_image_size is on.
                "match_reference": (list(_MATCH_REFERENCES), {
                    "default": _DEFAULT_MATCH_REFERENCE,
                    "tooltip": "Which image the others are scaled to when match_image_size is on. first: the "
                               "first in the list. largest / smallest: the tallest or shortest image in a "
                               "horizontal strip (widest or narrowest in a vertical one), the largest or "
                               "smallest by area in a grid. The reference keeps its own size, so smallest "
                               "never enlarges anything.",
                }),
                # Added after 1.2 for the width/height outputs: last again, so
                # every earlier widget keeps its slot in saved workflows.
                "size_reference": ("INT", {
                    "default": 1, "min": 1, "max": _MAX_IMAGES, "step": 1,
                    "tooltip": "Which image the width and height outputs describe, by its number in the "
                               "list: 1 = the first, 2 = the second… Frames from the IMAGE input count after "
                               "the pasted images; a number past the end means the last image. Its size "
                               "after crop and rotation, rescaled to size_megapixels when that is above 0, "
                               "with each side snapped to a multiple of size_divisible_by.",
                }),
                "size_megapixels": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 64.0, "step": 0.05, "round": 0.01,
                    "tooltip": "Rescale the width and height outputs to cover this many megapixels, keeping "
                               "the reference image's aspect ratio. 0 keeps its own pixel count.",
                }),
                "size_divisible_by": ("INT", {
                    "default": 32, "min": 1, "max": 512, "step": 1,
                    "tooltip": "Snap the width and height outputs to the nearest multiple of this many "
                               "pixels, never below one multiple. Latents need a multiple of 8; 32 or 64 "
                               "suits most models.",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "INT", "INT")
    RETURN_NAMES = ("image", "cells", "width", "height")
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
        "Width of image number size_reference (1 = the first), rescaled to size_megapixels and "
        "snapped to size_divisible_by — for an Empty Latent or a resize node downstream.",
        "Height of image number size_reference (1 = the first), rescaled to size_megapixels and "
        "snapped to size_divisible_by — for an Empty Latent or a resize node downstream.",
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
        match_reference=_LEGACY_MATCH_REFERENCE,
        size_reference=1,
        size_megapixels=0.0,
        size_divisible_by=32,
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

        # The size outputs come from the same measurements the canvas is laid
        # out from, so they describe an image as it lands there. They cost
        # nothing, so a bad choice is rejected before anything is decoded.
        width, height = _reference_size(dimensions, size_reference, size_megapixels, size_divisible_by)

        # Decode pass: _compose_from validates the canvas first, then pulls
        # each source through its loader one at a time.
        image, cells = _compose_from(
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
        # What this node just stitched, for the gallery to offer back later.
        # It never raises and honours the gallery's own "save every run".
        gallery.record_run(
            valid_items,
            {
                "direction": direction, "match_image_size": match_image_size,
                "spacing_width": spacing_width, "spacing_color": spacing_color,
                "layout_mode": layout_mode, "grid_columns": grid_columns,
                "custom_spacing_color": custom_spacing_color, "output_limit": output_limit,
                "output_limit_px": output_limit_px, "grid_cell_width": grid_cell_width,
                "grid_cell_height": grid_cell_height, "output_cells": output_cells,
                "cells_resolution": cells_resolution, "minimum_image_side": minimum_image_side,
                "match_reference": match_reference, "size_reference": size_reference,
                "size_megapixels": size_megapixels, "size_divisible_by": size_divisible_by,
            },
            image,
            input_frames=len(frames),
        )
        return image, cells, width, height

    @classmethod
    def VALIDATE_INPUTS(cls, images_json="[]"):
        """Report a corrupt list or a missing file when the prompt is queued.

        Only what costs nothing is checked — the shape of the list and whether
        each file is still there — so queueing stays instant; no image is
        decoded and every size and choice guard still runs in stitch().
        """
        try:
            items = json.loads(images_json or "[]")
        except json.JSONDecodeError:
            return "Multi Stitch Images: corrupted image list in workflow."
        if not isinstance(items, list):
            return "Multi Stitch Images: image list must be an array."
        for item in items:
            if not isinstance(item, dict):
                continue
            try:
                _safe_input_path(item)
            except (ValueError, OSError) as exc:
                return str(exc)
        return True

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


# --- Temporary videos for frame capture ---------------------------------------
# The frontend uploads a video to ComfyUI's temp folder (type "temp", the
# subfolder below) only to pick frames from it; every capture becomes an
# ordinary PNG in the input folder. The video is never part of the stitch, so
# the node ignores it. The delete route lets the frontend remove the file as
# soon as the captures are done; ComfyUI empties the temp folder on start-up
# for anything a closed browser left behind. The info, frame and capture
# routes decode frames on the server with PyAV — for formats a browser cannot
# play, and for a capture at exactly the time asked for. PyAV is optional:
# those routes answer 501 without it, and the stitch itself never needs it.
_VIDEO_SUBFOLDER = "multi_stitch_video"
_VIDEO_EXTENSIONS = {
    ".mp4", ".m4v", ".webm", ".mov", ".mkv", ".ogv", ".ogg", ".avi", ".mpg", ".mpeg", ".3gp", ".ts", ".wmv",
}


def _temp_video_path(filename: object) -> Path:
    """The temp-folder path a frontend-named video may live at, or ValueError."""
    name = str(filename or "")
    if not name or name in {".", ".."} or "/" in name or "\\" in name or "\x00" in name:
        raise ValueError(f"Multi Stitch Images: not a video file name: {name!r}")
    if Path(name).suffix.lower() not in _VIDEO_EXTENSIONS:
        raise ValueError(f"Multi Stitch Images: not a video file name: {name!r}")
    root = (Path(folder_paths.get_temp_directory()) / _VIDEO_SUBFOLDER).resolve()
    path = (root / name).resolve()
    if path.parent != root:
        raise ValueError(f"Multi Stitch Images: not inside the temporary video folder: {name!r}")
    return path


def _delete_temp_video(filename: object) -> bool:
    """Remove one uploaded video; False when it is already gone.

    Anything else the filesystem refuses — a directory sitting under that name,
    or Windows holding the file open while a decode reads it — is reported in
    the node's own voice so the route can list the name as rejected instead of
    answering 500.
    """
    path = _temp_video_path(filename)
    try:
        path.unlink()
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise ValueError(
            f"Multi Stitch Images: could not delete the video {path.name!r} ({exc})."
        ) from exc
    return True


def _video_delete_response(payload: object) -> tuple[int, dict]:
    """(status, body) for the delete route; pure so it is testable without aiohttp."""
    if not isinstance(payload, dict):
        return 400, {"error": "expected a JSON object with \"filenames\""}
    names = payload.get("filenames")
    if names is None:
        names = [payload.get("filename")]
    if not isinstance(names, list) or not names or len(names) > 64:
        return 400, {"error": "\"filenames\" must be a list of 1 to 64 names"}
    removed: list[str] = []
    missing: list[str] = []
    rejected: list[str] = []
    for name in names:
        try:
            (removed if _delete_temp_video(name) else missing).append(str(name))
        except (ValueError, OSError):
            rejected.append(str(name))
    status = 400 if rejected and not removed and not missing else 200
    return status, {"removed": removed, "missing": missing, "rejected": rejected}


_CAPTURE_SUBFOLDER = "multi_stitch"
_PREVIEW_MAX_SIDE = 720
_PREVIEW_SIDE_CAP = 2048
_PREVIEW_JPEG_QUALITY = 88
# A frame is on screen from its own timestamp on. The slack keeps a time the
# browser rounded to milliseconds on the frame it meant, not the one before.
_FRAME_TIME_SLACK = 1e-4


class _UnreadableVideo(Exception):
    """The file opened, but holds nothing FFmpeg can decode as video."""


def _av():
    """PyAV, imported only when a video route runs: the node stitches without it."""
    try:
        import av
    except ImportError as exc:
        raise ImportError("PyAV is not installed; run: pip install av") from exc
    return av


def _open_video(filename: object):
    """Open one uploaded video with PyAV; FileNotFoundError once it is deleted."""
    path = _temp_video_path(filename)
    av = _av()
    if not path.is_file():
        raise FileNotFoundError(f"Multi Stitch Images: video not found: {path.name}")
    return av.open(str(path))


def _video_stream(container):
    """The first video stream, decoding on every core the codec can use."""
    if not container.streams.video:
        raise _UnreadableVideo("Multi Stitch Images: the file has no video stream.")
    stream = container.streams.video[0]
    stream.thread_type = "AUTO"
    return stream


def _stream_seconds(stream, timestamp) -> float:
    """A stream timestamp as seconds; 0 when the header does not say."""
    if timestamp is None or stream.time_base is None:
        return 0.0
    return float(timestamp * stream.time_base)


def _video_duration(container, stream) -> float:
    """Seconds of video: the stream's own length, else the container's."""
    if stream.duration is not None:
        return max(0.0, _stream_seconds(stream, stream.duration))
    if container.duration is not None:
        return max(0.0, container.duration / _av().time_base)
    return 0.0


def _display_rotation(stream, frame=None) -> int:
    """Clockwise degrees (0, 90, 180 or 270) a player turns the picture by.

    Older demuxers export a "rotate" tag, already clockwise; current FFmpeg
    keeps only the display matrix, which PyAV reads off a decoded frame as a
    counter-clockwise angle — hence the sign flip.
    """
    try:
        degrees = float(stream.metadata.get("rotate", ""))
    except (TypeError, ValueError):
        counter_clockwise = getattr(frame, "rotation", None)
        degrees = -float(counter_clockwise) if counter_clockwise is not None else 0.0
    if not math.isfinite(degrees):
        degrees = 0.0
    return int(round(degrees / 90.0)) * 90 % 360


def _decode_from_keyframe(container, stream, target: int, limit: float):
    """The first frame out after seeking to `target` (stream time-base units)
    and the frames that follow it.

    Formats with an index (MP4, Matroska, AVI) seek straight to the keyframe
    before the target. MPEG-TS has none: its seek lands on whatever packet is
    there, and a P-frame decoded without its reference is grey mush, so retry
    further back, doubling the distance, until the first frame out is a
    keyframe that starts in time — or the start of the stream is reached.
    """
    back = 0
    while True:
        container.seek(max(0, target - back), backward=True, any_frame=False, stream=stream)
        frames = container.decode(stream)
        first = next(frames, None)
        settled = first is None or (first.key_frame and (first.time is None or first.time <= limit))
        if settled or target - back <= 0:
            return first, frames
        back = back * 2 if back else int(1 / stream.time_base)


def _decode_frame_at(container, stream, seconds: float):
    """The frame on screen at `seconds` into the stream.

    Decode forward from the keyframe before it to the last frame that starts
    at or before it. A time before the first frame gets that frame and a time
    past the last gets the last, so a request never comes back empty. A stream
    that starts late (MPEG-TS) counts from its first frame, as a browser's
    currentTime does.
    """
    origin = stream.start_time or 0
    limit = _stream_seconds(stream, origin) + seconds + _FRAME_TIME_SLACK
    chosen, frames = _decode_from_keyframe(container, stream, int(origin + seconds / stream.time_base), limit)
    for frame in frames:
        if frame.time is None or frame.time > limit:
            break
        chosen = frame
    if chosen is None:
        raise _UnreadableVideo("Multi Stitch Images: the video has no frame to decode.")
    return chosen


def _frame_image(frame, max_side: int) -> Image.Image:
    """The decoded frame as an RGB image, at most `max_side` on its long side.

    Scaling inside the colour conversion lets swscale do the work on the native
    planes; converting a 4K frame to RGB in full and resizing afterwards costs
    several times as much for the same result size. The long side is the same
    either way, so a rotation applied afterwards lands on the size the caller
    would have got from resizing the finished image.
    """
    long_side = max(frame.width, frame.height)
    if max_side <= 0 or long_side <= max_side:
        return frame.to_image()
    scale = max_side / long_side
    return frame.reformat(
        width=max(1, int(round(frame.width * scale))),
        height=max(1, int(round(frame.height * scale))),
        format="rgb24",
    ).to_image()


def _video_frame_at(filename: object, seconds: float, max_side: int = 0) -> tuple[Image.Image, float]:
    """The frame displayed at `seconds` (clamped to the video) as an RGB image
    turned the way a player shows it, with the time actually used. A max_side
    above zero bounds the long side, scaled while the frame is decoded."""
    seconds = float(seconds)
    with _open_video(filename) as container:
        stream = _video_stream(container)
        duration = _video_duration(container, stream)
        # An unknown length reads as 0; it must not pin every request to the start.
        seconds = max(0.0, min(seconds, duration) if duration > 0 else seconds)
        frame = _decode_frame_at(container, stream, seconds)
        rotation = _display_rotation(stream, frame)
        image = _apply_transform(_frame_image(frame, max_side), {"rotation": rotation})
    return image, seconds


def _video_frame(filename: object, seconds: float) -> Image.Image:
    """The frame displayed at `seconds`, as a browser would show it."""
    return _video_frame_at(filename, seconds)[0]


def _video_info(filename: object) -> dict:
    """What the picker needs to scrub and step: seconds, frame rate, the size
    as displayed, the frame count when the header has one, and the rotation."""
    with _open_video(filename) as container:
        stream = _video_stream(container)
        # The display matrix rides on decoded frames, so read it off the first.
        rotation = _display_rotation(stream, next(container.decode(stream), None))
        width, height = int(stream.width), int(stream.height)
        if rotation in {90, 270}:
            width, height = height, width
        rate = stream.average_rate or stream.guessed_rate
        return {
            "duration": _video_duration(container, stream),
            "fps": float(rate) if rate else 0.0,
            "width": width,
            "height": height,
            "frames": int(stream.frames or 0),
            "rotation": rotation,
        }


def _is_unreadable_video(exc: BaseException) -> bool:
    """PyAV's own errors count too, found without importing PyAV where it is absent."""
    ffmpeg_error = getattr(sys.modules.get("av"), "FFmpegError", ())
    return isinstance(exc, (_UnreadableVideo, ffmpeg_error))


def _video_failure(exc: Exception) -> tuple[int, dict]:
    """(status, body) for a failure inside the video helpers.

    Checked in this order because PyAV's errors double as built-ins: its
    FileNotFoundError is one, and its InvalidDataError is a ValueError. A
    filesystem refusal below those — no permission to read the upload or to
    write the capture, a directory in the way — answers 500 in the node's own
    voice rather than as an aiohttp traceback. Anything else is a bug and is
    raised again, for aiohttp's own 500.
    """
    if isinstance(exc, ImportError):
        return 501, {"error": "PyAV is not installed; run: pip install av"}
    if isinstance(exc, FileNotFoundError):
        return 404, {"error": "video not found; add it to the node again"}
    if _is_unreadable_video(exc):
        return 415, {"error": f"PyAV could not decode the video ({exc})"}
    if isinstance(exc, ValueError):
        return 400, {"error": str(exc)}
    if isinstance(exc, OSError):
        return 500, {"error": f"Multi Stitch Images: the server could not read or write the file ({exc})"}
    raise exc


def _video_request(query: object) -> dict:
    if not isinstance(query, dict):
        raise ValueError('expected "filename" (and "time") in the request')
    return query


def _query_seconds(query: dict) -> float:
    try:
        seconds = float(query.get("time"))
    except (TypeError, ValueError) as exc:
        raise ValueError('"time" must be a number of seconds') from exc
    if not math.isfinite(seconds):
        raise ValueError('"time" must be a number of seconds')
    return seconds


def _preview_max_side(query: dict) -> int:
    try:
        side = float(query.get("max_side", _PREVIEW_MAX_SIDE))
    except (TypeError, ValueError) as exc:
        raise ValueError('"max_side" must be a number of pixels') from exc
    # int(inf) raises OverflowError, which would leave the route at 500.
    if not math.isfinite(side):
        raise ValueError('"max_side" must be a number of pixels')
    return max(1, min(_PREVIEW_SIDE_CAP, int(side)))


def _jpeg_preview(image: Image.Image, max_side: int) -> bytes:
    """The frame as a JPEG whose long side is at most max_side."""
    scale = max_side / max(image.size)
    if scale < 1:
        size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
        image = image.resize(size, Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=_PREVIEW_JPEG_QUALITY)
    return buffer.getvalue()


def _video_info_response(query: object) -> tuple[int, dict]:
    """(status, body) for the info route; pure so it is testable without aiohttp."""
    try:
        return 200, _video_info(_video_request(query).get("filename"))
    except Exception as exc:
        return _video_failure(exc)


def _video_preview_response(query: object) -> tuple[int, object, str]:
    """(status, body, content type) for the frame route: JPEG bytes, or a JSON error."""
    try:
        query = _video_request(query)
        max_side = _preview_max_side(query)
        image, _ = _video_frame_at(query.get("filename"), _query_seconds(query), max_side)
        return 200, _jpeg_preview(image, max_side), "image/jpeg"
    except Exception as exc:
        return (*_video_failure(exc), "application/json")


def _capture_path() -> Path:
    """A fresh PNG path under input/multi_stitch: time-ordered, never colliding."""
    folder = Path(folder_paths.get_input_directory()) / _CAPTURE_SUBFOLDER
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"multi_stitch_{int(time.time() * 1000)}_{secrets.token_hex(4)}.png"


def _video_capture_response(payload: object) -> tuple[int, dict]:
    """(status, body) for the capture route: the frame saved full size as a PNG
    in the input folder, described the way /upload/image describes an upload
    (name, subfolder, type) plus its size and the time it was taken at."""
    try:
        payload = _video_request(payload)
        image, seconds = _video_frame_at(payload.get("filename"), _query_seconds(payload))
        path = _capture_path()
        image.save(path, format="PNG")
    except Exception as exc:
        return _video_failure(exc)
    return 200, {
        "name": path.name,
        "subfolder": _CAPTURE_SUBFOLDER,
        "type": "input",
        "width": image.width,
        "height": image.height,
        "time": seconds,
    }


try:
    from aiohttp import web as _web
    from server import PromptServer as _PromptServer
except Exception:  # not inside ComfyUI: tests and tooling import this module too
    _web = None
    _PromptServer = None

if _web is not None and getattr(_PromptServer, "instance", None) is not None:
    async def _off_loop(function, *args):
        """Decode in a worker thread: a seek and decode of a big video takes
        long enough to stall every other request if it ran on the event loop."""
        return await asyncio.get_running_loop().run_in_executor(None, function, *args)

    @_PromptServer.instance.routes.post("/multi_stitch/video/delete")
    async def _delete_temp_video_route(request):
        try:
            payload = await request.json()
        except Exception:
            payload = None
        status, body = _video_delete_response(payload)
        return _web.json_response(body, status=status)

    @_PromptServer.instance.routes.get("/multi_stitch/video/info")
    async def _video_info_route(request):
        status, body = await _off_loop(_video_info_response, dict(request.query))
        return _web.json_response(body, status=status)

    @_PromptServer.instance.routes.get("/multi_stitch/video/frame")
    async def _video_frame_route(request):
        status, body, content_type = await _off_loop(_video_preview_response, dict(request.query))
        if content_type != "image/jpeg":
            return _web.json_response(body, status=status)
        return _web.Response(body=body, status=status, content_type=content_type)

    async def _json_body(request):
        """The request body as JSON, or None when it is not JSON at all."""
        try:
            return await request.json()
        except Exception:
            return None

    @_PromptServer.instance.routes.get("/multi_stitch/gallery")
    async def _gallery_list_route(request):
        return _web.json_response(await _off_loop(gallery.listing))

    @_PromptServer.instance.routes.post("/multi_stitch/gallery/save")
    async def _gallery_save_route(request):
        status, body = await _off_loop(gallery.save_request, await _json_body(request))
        return _web.json_response(body, status=status)

    @_PromptServer.instance.routes.post("/multi_stitch/gallery/rename")
    async def _gallery_rename_route(request):
        payload = await _json_body(request) or {}
        status, body = await _off_loop(gallery.rename, payload.get("id"), payload.get("name"))
        return _web.json_response(body, status=status)

    @_PromptServer.instance.routes.post("/multi_stitch/gallery/delete")
    async def _gallery_delete_route(request):
        payload = await _json_body(request) or {}
        status, body = await _off_loop(
            gallery.delete, payload.get("ids"), bool(payload.get("files")), payload.get("keep"),
        )
        return _web.json_response(body, status=status)

    @_PromptServer.instance.routes.post("/multi_stitch/gallery/cleanup")
    async def _gallery_cleanup_route(request):
        payload = await _json_body(request) or {}
        status, body = await _off_loop(gallery.cleanup, payload.get("keep"))
        return _web.json_response(body, status=status)

    @_PromptServer.instance.routes.post("/multi_stitch/gallery/settings")
    async def _gallery_settings_route(request):
        status, body = await _off_loop(gallery.set_settings, await _json_body(request))
        return _web.json_response(body, status=status)

    @_PromptServer.instance.routes.post("/multi_stitch/video/capture")
    async def _video_capture_route(request):
        try:
            payload = await request.json()
        except Exception:
            payload = None
        status, body = await _off_loop(_video_capture_response, payload)
        return _web.json_response(body, status=status)


NODE_CLASS_MAPPINGS = {
    "MultiStitchImages": MultiStitchImages,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MultiStitchImages": "Multi Stitch Images",
}
