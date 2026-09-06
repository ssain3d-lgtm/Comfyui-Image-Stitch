import json
import math
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

    # Avoid zero-area crops from malformed workflow data.
    if w <= 0.000001 or h <= 0.000001:
        return 0.0, 0.0, 1.0, 1.0
    return x, y, w, h


def _load_image(item: dict) -> torch.Tensor:
    path = _safe_input_path(item)
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
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


def _resize_for_direction(image: torch.Tensor, direction: str, target_h: int, target_w: int) -> torch.Tensor:
    h, w = image.shape[1], image.shape[2]
    if direction in {"left", "right"}:
        new_h = target_h
        new_w = max(1, int(round(w * (target_h / h))))
    else:
        new_w = target_w
        new_h = max(1, int(round(h * (target_w / w))))

    if (new_h, new_w) == (h, w):
        return image

    nchw = image.movedim(-1, 1)
    resized = F.interpolate(nchw, size=(new_h, new_w), mode="bicubic", align_corners=False, antialias=True)
    return resized.movedim(1, -1).clamp_(0.0, 1.0)


def _compose(images: list[torch.Tensor], direction: str, match_image_size: bool, spacing_width: int, spacing_color: str) -> torch.Tensor:
    if not images:
        raise ValueError("Multi Stitch Images: paste or add at least one image first.")

    direction = direction if direction in {"right", "down", "left", "up"} else "right"
    spacing_width = max(0, int(spacing_width))
    spacing_color = spacing_color if spacing_color in _COLOR_MAP else "white"

    first_h, first_w = images[0].shape[1], images[0].shape[2]
    if match_image_size:
        prepared = [images[0]]
        prepared.extend(_resize_for_direction(img, direction, first_h, first_w) for img in images[1:])
    else:
        prepared = images

    # Repeated Stitch Images with left/up places every new image before the accumulated result.
    if direction in {"left", "up"}:
        prepared = list(reversed(prepared))

    color = torch.tensor(_COLOR_MAP[spacing_color], dtype=prepared[0].dtype)
    # Core Stitch Images uses black for unmatched-size padding with non black/white spacing colors.
    pad_color = color if spacing_color in {"white", "black"} else torch.zeros(3, dtype=prepared[0].dtype)

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


class MultiStitchImages:
    """Paste many images into one node, optionally crop each one, then stitch them."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "direction": (["right", "down", "left", "up"], {"default": "right"}),
                "match_image_size": ("BOOLEAN", {"default": True}),
                "spacing_width": ("INT", {"default": 0, "min": 0, "max": 1024, "step": 2}),
                "spacing_color": (["white", "black", "red", "green", "blue"], {"default": "white"}),
                # Hidden by web/multi_stitch.js. Kept as a normal widget so the image list
                # participates in prompt serialization and invalidates execution correctly.
                "images_json": ("STRING", {"default": "[]", "multiline": True}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "stitch"
    CATEGORY = "image/transform"
    DESCRIPTION = (
        "Paste multiple images directly into this node with Ctrl+V, click a thumbnail to crop, "
        "then stitch all images using the same direction/size/spacing controls as Stitch Images."
    )

    def stitch(self, direction, match_image_size, spacing_width, spacing_color, images_json):
        try:
            items = json.loads(images_json or "[]")
        except json.JSONDecodeError as exc:
            raise ValueError("Multi Stitch Images: corrupted image list in workflow.") from exc

        if not isinstance(items, list):
            raise ValueError("Multi Stitch Images: image list must be an array.")
        if len(items) > 256:
            raise ValueError("Multi Stitch Images: maximum 256 images per node.")

        images = [_load_image(item) for item in items if isinstance(item, dict)]
        return (_compose(images, direction, match_image_size, spacing_width, spacing_color),)


NODE_CLASS_MAPPINGS = {
    "MultiStitchImages": MultiStitchImages,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MultiStitchImages": "Multi Stitch Images",
}
