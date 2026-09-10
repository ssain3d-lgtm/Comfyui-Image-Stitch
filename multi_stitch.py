import functools
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
    """EXIF orientation from the bytes the header already exposed.

    Deliberately not ``source.getexif()``: Pillow's PNG plugin decodes the
    whole image inside getexif() when no eXIf chunk preceded the pixel data,
    which is every pasted screenshot. ImageOps.exif_transpose() goes further
    and always decodes, because it copies the image even when nothing needs
    transposing. Both the measurement pass and the decode pass use this one
    function, so they can never disagree about an image's orientation.
    """
    raw = source.info.get("exif")
    if not raw:
        return 1
    try:
        exif = Image.Exif()
        exif.load(raw)
        return int(exif.get(_EXIF_ORIENTATION, 1))
    except Exception:  # a malformed EXIF block must not make a decodable image unusable
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


def _prepared_strip_dims(
    dimensions: list[tuple[int, int]],
    direction: str,
    match_image_size: bool,
) -> list[tuple[int, int]]:
    """Size of each strip image after match_image_size, in list order.

    Shared by the estimate and the composition, so the canvas measured before
    decoding is the canvas actually filled.
    """
    if not match_image_size or len(dimensions) <= 1:
        return list(dimensions)
    first_w, first_h = dimensions[0]
    prepared = [dimensions[0]]
    for w, h in dimensions[1:]:
        if direction in {"left", "right"}:
            prepared.append((max(1, int(round(w * (first_h / h)))), first_h))
        else:
            prepared.append((first_w, max(1, int(round(h * (first_w / w))))))
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


def _estimate_output_dimensions(
    dimensions: list[tuple[int, int]],
    layout_mode: str,
    direction: str,
    match_image_size: bool,
    grid_columns: int,
    spacing_width: int,
) -> tuple[int, int]:
    """Estimate the exact canvas size using the same resize rules as composition."""
    if not dimensions:
        raise ValueError("Multi Stitch Images: paste or add at least one image first.")

    direction = _require_choice("direction", direction, _DIRECTIONS)
    layout_mode = _require_choice("layout_mode", layout_mode, _LAYOUT_MODES)
    spacing_width = max(0, int(spacing_width))
    dims = [(max(1, int(w)), max(1, int(h))) for w, h in dimensions]

    if layout_mode == "grid":
        rows, cols = _grid_shape(len(dims), grid_columns, direction)
        if match_image_size:
            cell_w, cell_h = dims[0]
        else:
            cell_w = max(w for w, _ in dims)
            cell_h = max(h for _, h in dims)
        return (
            cols * cell_w + spacing_width * (cols - 1),
            rows * cell_h + spacing_width * (rows - 1),
        )

    dims = _prepared_strip_dims(dims, direction, match_image_size)

    if direction in {"left", "right"}:
        return (
            sum(w for w, _ in dims) + spacing_width * (len(dims) - 1),
            max(h for _, h in dims),
        )
    return (
        max(w for w, _ in dims),
        sum(h for _, h in dims) + spacing_width * (len(dims) - 1),
    )


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


def _compose_strip(
    loaders: list[Loader],
    dimensions: list[tuple[int, int]],
    direction: str,
    match_image_size: bool,
    spacing_width: int,
    color_tuple: tuple[float, float, float],
) -> torch.Tensor:
    # Every position comes from the measured dimensions, so the canvas is
    # allocated up front and each source is decoded, placed and released in
    # turn. spacing_color is the node's background: the canvas starts filled
    # with it, which is what makes both the separator bars and the letterbox
    # padding that colour in strip and grid alike.
    prepared = _prepared_strip_dims(dimensions, direction, match_image_size)
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
    output = _blank_canvas(out_w, out_h, color_tuple)

    cursor = 0
    for index in order:
        w, h = prepared[index]
        image = _resize_exact(_load_checked(loaders[index], dimensions[index], index), h, w)
        if horizontal:
            y = (out_h - h) // 2
            output[:, y:y + h, cursor:cursor + w, :] = image.to(output)
            cursor += w + spacing_width
        else:
            x = (out_w - w) // 2
            output[:, cursor:cursor + h, x:x + w, :] = image.to(output)
            cursor += h + spacing_width
        del image  # release this source before the next one is decoded
    return output


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


def _compose_grid(
    loaders: list[Loader],
    dimensions: list[tuple[int, int]],
    direction: str,
    match_image_size: bool,
    grid_columns: int,
    spacing_width: int,
    color_tuple: tuple[float, float, float],
) -> torch.Tensor:
    rows, cols = _grid_shape(len(dimensions), grid_columns, direction)

    if match_image_size:
        cell_w, cell_h = dimensions[0]
        placed = [_fit_size(w, h, cell_w, cell_h) for w, h in dimensions]
    else:
        cell_w = max(w for w, _ in dimensions)
        cell_h = max(h for _, h in dimensions)
        placed = list(dimensions)

    out_w = cols * cell_w + spacing_width * (cols - 1)
    out_h = rows * cell_h + spacing_width * (rows - 1)
    output = _blank_canvas(out_w, out_h, color_tuple)

    for index, loader in enumerate(loaders):
        row, col = _grid_position(index, rows, cols, direction)
        w, h = placed[index]
        image = _resize_exact(_load_checked(loader, dimensions[index], index), h, w)
        y = row * (cell_h + spacing_width) + (cell_h - h) // 2
        x = col * (cell_w + spacing_width) + (cell_w - w) // 2
        output[:, y:y + h, x:x + w, :] = image.to(output)
        del image  # release this source before the next one is decoded

    return output


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
) -> torch.Tensor:
    """Compose from lazy sources: each loader is called once, in placement order.

    Validation happens before any loader runs, so an oversized result is
    rejected without decoding a single image. The output is CPU float32
    [1, H, W, 3] as ComfyUI expects.
    """
    if not loaders:
        raise ValueError("Multi Stitch Images: paste or add at least one image first.")
    if len(loaders) != len(dimensions):
        raise ValueError("Multi Stitch Images: internal error, one measurement per image is required.")

    direction = _require_choice("direction", direction, _DIRECTIONS)
    layout_mode = _require_choice("layout_mode", layout_mode, _LAYOUT_MODES)
    spacing_width = max(0, int(spacing_width))
    color_tuple = _resolve_color(spacing_color, custom_spacing_color)
    dimensions = [(max(1, int(w)), max(1, int(h))) for w, h in dimensions]

    out_w, out_h = _estimate_output_dimensions(
        dimensions,
        layout_mode,
        direction,
        match_image_size,
        grid_columns,
        spacing_width,
    )
    _validate_output_dimensions(out_w, out_h)

    if layout_mode == "grid":
        return _compose_grid(
            loaders,
            dimensions,
            direction,
            match_image_size,
            grid_columns,
            spacing_width,
            color_tuple,
        )
    return _compose_strip(
        loaders,
        dimensions,
        direction,
        match_image_size,
        spacing_width,
        color_tuple,
    )


def _compose(
    images: list[torch.Tensor],
    layout_mode: str,
    direction: str,
    match_image_size: bool,
    grid_columns: int,
    spacing_width: int,
    spacing_color: str,
    custom_spacing_color: str,
) -> torch.Tensor:
    """Compose already-decoded tensors; the same path stitch() streams through."""
    dimensions = [(int(img.shape[2]), int(img.shape[1])) for img in images]
    loaders: list[Loader] = [functools.partial(lambda tensor: tensor, img) for img in images]
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
    )


class MultiStitchImages:
    """Paste many images into one node, edit each one, then stitch or arrange as a grid."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # Keep the first five widgets in the original v1 order so older
                # saved workflows load without widget-value shifting.
                "direction": (["right", "down", "left", "up"], {"default": "right"}),
                "match_image_size": ("BOOLEAN", {"default": True}),
                "spacing_width": ("INT", {"default": 0, "min": 0, "max": 1024, "step": 2}),
                "spacing_color": (["white", "black", "red", "green", "blue", "custom"], {"default": "white"}),
                "images_json": ("STRING", {"default": "[]", "multiline": True}),
                "layout_mode": (["strip", "grid"], {"default": "strip"}),
                "grid_columns": ("INT", {"default": 3, "min": 1, "max": 16, "step": 1}),
                "custom_spacing_color": ("STRING", {"default": "#808080"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "stitch"
    CATEGORY = "image/transform"
    DESCRIPTION = (
        "Paste multiple images directly into this node with Ctrl+V, click an image to edit, "
        "drag its ≡ handle to reorder, then output a strip or grid."
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
    ):
        try:
            items = json.loads(images_json or "[]")
        except json.JSONDecodeError as exc:
            raise ValueError("Multi Stitch Images: corrupted image list in workflow.") from exc

        if not isinstance(items, list):
            raise ValueError("Multi Stitch Images: image list must be an array.")
        if len(items) > _MAX_IMAGES:
            raise ValueError(f"Multi Stitch Images: maximum {_MAX_IMAGES} images per node.")

        valid_items = [item for item in items if isinstance(item, dict)]

        # Header-only pass: measure every source and its footprint on the
        # canvas, and refuse an original that would be too big to decode.
        dimensions = []
        for item in valid_items:
            (source_w, source_h), output_size = _inspect_item(item)
            _validate_source_pixels(item, source_w, source_h)
            dimensions.append(output_size)

        # Decode pass: _compose_from validates the canvas first, then pulls
        # each source through its loader one at a time.
        background = _resolve_color(spacing_color, custom_spacing_color)
        loaders: list[Loader] = [
            functools.partial(_load_image, item, background) for item in valid_items
        ]
        return (
            _compose_from(
                loaders,
                dimensions,
                layout_mode,
                direction,
                match_image_size,
                grid_columns,
                spacing_width,
                spacing_color,
                custom_spacing_color,
            ),
        )


NODE_CLASS_MAPPINGS = {
    "MultiStitchImages": MultiStitchImages,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MultiStitchImages": "Multi Stitch Images",
}
