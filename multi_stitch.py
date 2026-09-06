import json
import math
import re
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps

import folder_paths


_COLOR_MAP = {
    "white": (1.0, 1.0, 1.0),
    "black": (0.0, 0.0, 0.0),
    "red": (1.0, 0.0, 0.0),
    "green": (0.0, 1.0, 0.0),
    "blue": (0.0, 0.0, 1.0),
}


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
        rotation = int(round(float(item.get("rotation", 0)) / 90.0) * 90) % 360
    except (TypeError, ValueError):
        rotation = 0
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


def _load_image(item: dict) -> torch.Tensor:
    path = _safe_input_path(item)
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        image = _apply_transform(image, item)
        x, y, w, h = _normalize_crop(item.get("crop"))

        width, height = image.size
        left = max(0, min(width - 1, int(round(x * width))))
        top = max(0, min(height - 1, int(round(y * height))))
        right = max(left + 1, min(width, int(round((x + w) * width))))
        bottom = max(top + 1, min(height, int(round((y + h) * height))))

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


def _resize_for_direction(image: torch.Tensor, direction: str, target_h: int, target_w: int) -> torch.Tensor:
    h, w = image.shape[1], image.shape[2]
    if direction in {"left", "right"}:
        new_h = target_h
        new_w = max(1, int(round(w * (target_h / h))))
    else:
        new_w = target_w
        new_h = max(1, int(round(h * (target_w / w))))

    return _resize_exact(image, new_h, new_w)


def _fit_to_cell(image: torch.Tensor, cell_h: int, cell_w: int) -> torch.Tensor:
    h, w = image.shape[1], image.shape[2]
    scale = min(cell_h / h, cell_w / w)
    new_h = max(1, int(round(h * scale)))
    new_w = max(1, int(round(w * scale)))
    return _resize_exact(image, new_h, new_w)


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
    return _COLOR_MAP.get(spacing_color, _COLOR_MAP["white"])


def _compose_strip(
    images: list[torch.Tensor],
    direction: str,
    match_image_size: bool,
    spacing_width: int,
    color_tuple: tuple[float, float, float],
    spacing_color_name: str,
) -> torch.Tensor:
    first_h, first_w = images[0].shape[1], images[0].shape[2]
    if match_image_size:
        prepared = [images[0]]
        prepared.extend(_resize_for_direction(img, direction, first_h, first_w) for img in images[1:])
    else:
        prepared = images

    if direction in {"left", "up"}:
        prepared = list(reversed(prepared))

    color = torch.tensor(color_tuple, dtype=prepared[0].dtype, device=prepared[0].device)
    if spacing_color_name in {"white", "black", "custom"}:
        pad_color = color
    else:
        # Keep built-in Stitch Images behavior for classic named RGB spacing colors.
        pad_color = torch.zeros(3, dtype=prepared[0].dtype, device=prepared[0].device)

    if direction in {"left", "right"}:
        out_h = max(img.shape[1] for img in prepared)
        out_w = sum(img.shape[2] for img in prepared) + spacing_width * (len(prepared) - 1)
        output = pad_color.view(1, 1, 1, 3).expand(1, out_h, out_w, 3).clone()
        cursor = 0
        for i, img in enumerate(prepared):
            h, w = img.shape[1], img.shape[2]
            y = (out_h - h) // 2
            output[:, y:y + h, cursor:cursor + w, :] = img
            cursor += w
            if i < len(prepared) - 1 and spacing_width:
                output[:, :, cursor:cursor + spacing_width, :] = color
                cursor += spacing_width
        return output

    out_w = max(img.shape[2] for img in prepared)
    out_h = sum(img.shape[1] for img in prepared) + spacing_width * (len(prepared) - 1)
    output = pad_color.view(1, 1, 1, 3).expand(1, out_h, out_w, 3).clone()
    cursor = 0
    for i, img in enumerate(prepared):
        h, w = img.shape[1], img.shape[2]
        x = (out_w - w) // 2
        output[:, cursor:cursor + h, x:x + w, :] = img
        cursor += h
        if i < len(prepared) - 1 and spacing_width:
            output[:, cursor:cursor + spacing_width, :, :] = color
            cursor += spacing_width
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
    images: list[torch.Tensor],
    direction: str,
    match_image_size: bool,
    grid_columns: int,
    spacing_width: int,
    color_tuple: tuple[float, float, float],
) -> torch.Tensor:
    cols = max(1, min(int(grid_columns), len(images)))
    rows = math.ceil(len(images) / cols)

    if match_image_size:
        cell_h, cell_w = images[0].shape[1], images[0].shape[2]
        prepared = [_fit_to_cell(img, cell_h, cell_w) for img in images]
    else:
        cell_h = max(img.shape[1] for img in images)
        cell_w = max(img.shape[2] for img in images)
        prepared = images

    color = torch.tensor(color_tuple, dtype=prepared[0].dtype, device=prepared[0].device)
    out_h = rows * cell_h + spacing_width * (rows - 1)
    out_w = cols * cell_w + spacing_width * (cols - 1)
    output = color.view(1, 1, 1, 3).expand(1, out_h, out_w, 3).clone()

    for index, img in enumerate(prepared):
        row, col = _grid_position(index, rows, cols, direction)
        # Column-major flow can produce a final column index beyond cols only when
        # the user asks for fewer cells than images; clamp defensively.
        if row >= rows or col >= cols:
            continue
        h, w = img.shape[1], img.shape[2]
        cell_y = row * (cell_h + spacing_width)
        cell_x = col * (cell_w + spacing_width)
        y = cell_y + (cell_h - h) // 2
        x = cell_x + (cell_w - w) // 2
        output[:, y:y + h, x:x + w, :] = img

    return output


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
    if not images:
        raise ValueError("Multi Stitch Images: paste or add at least one image first.")

    direction = direction if direction in {"right", "down", "left", "up"} else "right"
    layout_mode = layout_mode if layout_mode in {"strip", "grid"} else "strip"
    spacing_width = max(0, int(spacing_width))
    color_tuple = _resolve_color(spacing_color, custom_spacing_color)

    if layout_mode == "grid":
        return _compose_grid(
            images,
            direction,
            match_image_size,
            grid_columns,
            spacing_width,
            color_tuple,
        )

    return _compose_strip(
        images,
        direction,
        match_image_size,
        spacing_width,
        color_tuple,
        spacing_color,
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
        "Paste multiple images directly into this node with Ctrl+V, drag thumbnails to reorder, "
        "click a thumbnail to crop/rotate/flip, then output a strip or grid."
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
        if len(items) > 256:
            raise ValueError("Multi Stitch Images: maximum 256 images per node.")

        images = [_load_image(item) for item in items if isinstance(item, dict)]
        return (
            _compose(
                images,
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
