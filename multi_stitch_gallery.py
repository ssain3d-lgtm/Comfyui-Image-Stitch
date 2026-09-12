"""Gallery of compositions for Multi Stitch Images.

The images a node uploads stay in ``input/multi_stitch/`` for as long as a
workflow may reference them, so the folder only ever grows. The gallery turns
that into something useful: every executed composition (the image list with
its crops and order, plus the widget settings) is recorded as a small JSON
entry with a preview, and the node can load or append any of them later.

Entries live in ``input/multi_stitch/gallery/<id>.json`` next to a
``<id>.jpg`` preview. Nothing here decodes images: previews are handed in by
the caller (the stitch has the composed result at hand), and deletion only
ever touches ``input/multi_stitch/`` itself.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import secrets
import time
from pathlib import Path

import folder_paths

_IMAGE_SUBFOLDER = "multi_stitch"
_GALLERY_SUBFOLDER = "gallery"
_MAX_ENTRIES = 200
_PREVIEW_SIDE = 384
_PREVIEW_QUALITY = 82
_NAME_LIMIT = 80
_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_FILE_PATTERN = re.compile(r"^[^/\\\0]{1,255}$")
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")

# The widget values that define a composition, in INPUT_TYPES order. Anything
# else in a request is ignored, so a gallery entry never carries surprises
# back into the node.
SETTING_KEYS = (
    "direction", "match_image_size", "spacing_width", "spacing_color", "layout_mode",
    "grid_columns", "custom_spacing_color", "output_limit", "output_limit_px",
    "grid_cell_width", "grid_cell_height", "output_cells", "cells_resolution",
    "minimum_image_side", "match_reference", "size_reference", "size_megapixels",
    "size_divisible_by",
)
_ITEM_KEYS = ("filename", "subfolder", "type", "crop", "rotation", "flip_h", "flip_v", "source")


def _image_dir() -> Path:
    return Path(folder_paths.get_input_directory()) / _IMAGE_SUBFOLDER


def _gallery_dir() -> Path:
    return _image_dir() / _GALLERY_SUBFOLDER


def _entry_paths(entry_id: str) -> tuple[Path, Path]:
    folder = _gallery_dir()
    return folder / f"{entry_id}.json", folder / f"{entry_id}.jpg"


def _settings_path() -> Path:
    return _gallery_dir() / "settings.json"


def settings() -> dict:
    """The gallery's own settings. Kept beside the entries rather than in a
    widget, so adding one never shifts a saved workflow's widget values."""
    try:
        with open(_settings_path(), encoding="utf-8") as handle:
            stored = json.load(handle)
    except (OSError, ValueError):
        stored = {}
    return {"autosave": bool(stored.get("autosave", True)) if isinstance(stored, dict) else True}


def set_settings(payload: object) -> tuple[int, dict]:
    if not isinstance(payload, dict):
        return 400, {"error": "Multi Stitch Images: expected a JSON object of gallery settings."}
    current = settings()
    if "autosave" in payload:
        current["autosave"] = bool(payload["autosave"])
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(current, handle)
    os.replace(tmp, path)
    return 200, {"settings": current}


def _valid_id(entry_id: object) -> str:
    if not isinstance(entry_id, str) or not _ID_PATTERN.match(entry_id):
        raise ValueError(f"Multi Stitch Images: not a gallery entry id: {entry_id!r}")
    return entry_id


def clean_name(name: object, fallback: str = "") -> str:
    """A display name without control characters, at most _NAME_LIMIT long."""
    text = _CONTROL_CHARS.sub("", str(name)) if isinstance(name, str) else ""
    text = " ".join(text.split())
    return text[:_NAME_LIMIT] or fallback


def normalize_images(items: object) -> list[dict]:
    """The image list as the node saves it, keeping only the known keys."""
    if not isinstance(items, list):
        raise ValueError("Multi Stitch Images: the gallery needs a list of images.")
    images = []
    for item in items:
        if not isinstance(item, dict):
            continue
        filename = item.get("filename")
        if not isinstance(filename, str) or not _FILE_PATTERN.match(filename):
            continue
        images.append({key: item[key] for key in _ITEM_KEYS if key in item})
    if not images:
        raise ValueError("Multi Stitch Images: the gallery needs at least one image.")
    return images


def normalize_settings(settings: object) -> dict:
    if not isinstance(settings, dict):
        return {}
    return {key: settings[key] for key in SETTING_KEYS if key in settings}


def composition_key(images: list[dict], settings: dict) -> str:
    """Identifies a composition: the same images, edits, order and settings."""
    payload = json.dumps({"images": images, "settings": settings}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def _read_entry(path: Path) -> dict | None:
    try:
        with open(path, encoding="utf-8") as handle:
            entry = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(entry, dict) or not isinstance(entry.get("images"), list):
        return None
    entry.setdefault("id", path.stem)
    entry["preview"] = entry_paths_exist(entry["id"])[1]
    return entry


def entry_paths_exist(entry_id: str) -> tuple[bool, bool]:
    json_path, jpg_path = _entry_paths(entry_id)
    return json_path.is_file(), jpg_path.is_file()


def list_entries() -> list[dict]:
    """Every readable entry, most recently used first."""
    folder = _gallery_dir()
    if not folder.is_dir():
        return []
    entries = []
    for path in folder.glob("*.json"):
        if path.name == "settings.json" or not _ID_PATTERN.match(path.stem):
            continue
        entry = _read_entry(path)
        if entry is not None:
            entries.append(entry)
    entries.sort(key=lambda entry: (entry.get("used") or entry.get("created") or 0), reverse=True)
    return entries


def _write_entry(entry: dict) -> None:
    json_path, _ = _entry_paths(entry["id"])
    json_path.parent.mkdir(parents=True, exist_ok=True)
    stored = {key: value for key, value in entry.items() if key != "preview"}
    tmp = json_path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(stored, handle, ensure_ascii=False, indent=1)
    os.replace(tmp, json_path)


def _write_preview(entry_id: str, preview) -> bool:
    """Saves a PIL image as the entry's JPEG preview (long side ≤ _PREVIEW_SIDE)."""
    if preview is None:
        return False
    _, jpg_path = _entry_paths(entry_id)
    jpg_path.parent.mkdir(parents=True, exist_ok=True)
    image = preview.convert("RGB")
    scale = _PREVIEW_SIDE / max(image.size)
    if scale < 1:
        image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))))
    image.save(jpg_path, "JPEG", quality=_PREVIEW_QUALITY, optimize=True)
    return True


def _new_id() -> str:
    return f"{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(3)}"


def _evict_oldest(entries: list[dict]) -> list[str]:
    """Keeps the gallery at _MAX_ENTRIES by dropping the least recently used."""
    removed = []
    if len(entries) <= _MAX_ENTRIES:
        return removed
    for entry in sorted(entries, key=lambda e: (e.get("used") or e.get("created") or 0))[: len(entries) - _MAX_ENTRIES]:
        _remove_entry_files(entry["id"])
        removed.append(entry["id"])
    return removed


def record(images: object, settings: object, preview=None, *, name: str | None = None,
           size: tuple[int, int] | None = None, input_frames: int = 0) -> dict:
    """Adds a composition, or marks the identical one as used again.

    ``preview`` is a PIL image of the composed result (or None to keep an
    existing preview / none). Returns the stored entry.
    """
    images = normalize_images(images)
    settings = normalize_settings(settings)
    key = composition_key(images, settings)
    now = time.time()
    entries = list_entries()
    existing = next((entry for entry in entries if entry.get("key") == key), None)
    if existing is not None:
        existing["used"] = now
        existing["uses"] = int(existing.get("uses") or 0) + 1
        if name:
            existing["name"] = clean_name(name, existing.get("name", ""))
        if preview is not None and not existing.get("preview"):
            _write_preview(existing["id"], preview)
        _write_entry(existing)
        return _read_entry(_entry_paths(existing["id"])[0]) or existing

    entry = {
        "id": _new_id(),
        "name": clean_name(name, time.strftime("%Y-%m-%d %H:%M")),
        "created": now,
        "used": now,
        "uses": 1,
        "key": key,
        "images": images,
        "settings": settings,
        "input_frames": int(input_frames or 0),
    }
    if size:
        entry["width"], entry["height"] = int(size[0]), int(size[1])
    _write_entry(entry)
    _write_preview(entry["id"], preview)
    _evict_oldest(entries + [entry])
    return _read_entry(_entry_paths(entry["id"])[0]) or entry


def rename(entry_id: object, name: object) -> tuple[int, dict]:
    try:
        entry_id = _valid_id(entry_id)
    except ValueError as exc:
        return 400, {"error": str(exc)}
    json_path, _ = _entry_paths(entry_id)
    entry = _read_entry(json_path) if json_path.is_file() else None
    if entry is None:
        return 404, {"error": "gallery entry not found"}
    entry["name"] = clean_name(name, entry.get("name", ""))
    _write_entry(entry)
    return 200, {"entry": entry}


def _remove_entry_files(entry_id: str) -> None:
    for path in _entry_paths(entry_id):
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass


def _image_file(name: object) -> Path | None:
    """The path of a stored image, or None for anything but a plain file name
    inside input/multi_stitch (never the gallery folder, never elsewhere)."""
    if not isinstance(name, str) or not _FILE_PATTERN.match(name) or name in (".", ".."):
        return None
    folder = _image_dir()
    path = folder / name
    try:
        if path.resolve().parent != folder.resolve():
            return None
    except OSError:
        return None
    return path if path.is_file() else None


def _stored_files() -> dict[str, int]:
    """Plain files in input/multi_stitch with their sizes (the gallery folder excluded)."""
    folder = _image_dir()
    if not folder.is_dir():
        return {}
    files = {}
    for entry in os.scandir(folder):
        if entry.is_file(follow_symlinks=False):
            try:
                files[entry.name] = entry.stat().st_size
            except OSError:
                continue
    return files


def _referenced(entries: list[dict]) -> set[str]:
    names = set()
    for entry in entries:
        for item in entry.get("images", []):
            if isinstance(item, dict) and item.get("subfolder", _IMAGE_SUBFOLDER) == _IMAGE_SUBFOLDER:
                names.add(item.get("filename"))
    return names


def storage_summary(entries: list[dict] | None = None) -> dict:
    entries = list_entries() if entries is None else entries
    files = _stored_files()
    referenced = _referenced(entries)
    unreferenced = {name: size for name, size in files.items() if name not in referenced}
    return {
        "files": len(files),
        "bytes": sum(files.values()),
        "unreferenced_files": len(unreferenced),
        "unreferenced_bytes": sum(unreferenced.values()),
        "entries": len(entries),
    }


def listing() -> dict:
    entries = list_entries()
    return {"entries": entries, "storage": storage_summary(entries), "settings": settings()}


def _keep_set(keep: object) -> set[str]:
    return {name for name in keep if isinstance(name, str)} if isinstance(keep, list) else set()


def delete(ids: object, delete_files: bool = False, keep: object = None) -> tuple[int, dict]:
    """Removes entries; with delete_files, also their images that no other
    entry and nothing in ``keep`` (the files the open workflow uses) references."""
    if isinstance(ids, str):
        ids = [ids]
    if not isinstance(ids, list) or not ids:
        return 400, {"error": "Multi Stitch Images: expected a list of gallery entry ids."}
    try:
        ids = [_valid_id(entry_id) for entry_id in ids]
    except ValueError as exc:
        return 400, {"error": str(exc)}
    entries = list_entries()
    doomed = [entry for entry in entries if entry["id"] in ids]
    remaining = [entry for entry in entries if entry["id"] not in ids]
    for entry in doomed:
        _remove_entry_files(entry["id"])
    files_removed, bytes_freed = 0, 0
    if delete_files and doomed:
        still_used = _referenced(remaining) | _keep_set(keep)
        for name in _referenced(doomed) - still_used:
            path = _image_file(name)
            if path is None:
                continue
            try:
                size = path.stat().st_size
                path.unlink()
            except OSError:
                continue
            files_removed += 1
            bytes_freed += size
    return 200, {
        "removed": [entry["id"] for entry in doomed],
        "missing": [entry_id for entry_id in ids if all(entry["id"] != entry_id for entry in doomed)],
        "files_removed": files_removed,
        "bytes_freed": bytes_freed,
        "storage": storage_summary(remaining),
    }


def cleanup(keep: object = None) -> tuple[int, dict]:
    """Deletes stored images that no gallery entry and nothing in ``keep`` references."""
    entries = list_entries()
    still_used = _referenced(entries) | _keep_set(keep)
    files_removed, bytes_freed = 0, 0
    for name, size in _stored_files().items():
        if name in still_used:
            continue
        path = _image_file(name)
        if path is None:
            continue
        try:
            path.unlink()
        except OSError:
            continue
        files_removed += 1
        bytes_freed += size
    return 200, {"files_removed": files_removed, "bytes_freed": bytes_freed, "storage": storage_summary(entries)}


def preview_from_tensor(image) -> object:
    """A PIL preview of a composed [1, H, W, 3] float tensor, reduced with area
    averaging so a 72 MP result costs one small pass and no full-size copy."""
    import numpy as np
    import torch
    import torch.nn.functional as F
    from PIL import Image

    tensor = image[0] if image.dim() == 4 else image
    height, width = int(tensor.shape[0]), int(tensor.shape[1])
    scale = min(1.0, _PREVIEW_SIDE / max(width, height))
    target = (max(1, math.floor(height * scale)), max(1, math.floor(width * scale)))
    small = tensor.permute(2, 0, 1).unsqueeze(0)
    if target != (height, width):
        small = F.interpolate(small.to(torch.float32), size=target, mode="area")
    array = (small[0].permute(1, 2, 0).clamp(0, 1) * 255).round().to(torch.uint8).cpu().numpy()
    return Image.fromarray(np.ascontiguousarray(array), "RGB")


def record_run(images: object, settings_used: object, image=None, *, input_frames: int = 0) -> dict | None:
    """Records a composition a run just produced, unless autosave is off.
    Never raises: a gallery problem must not fail someone's workflow."""
    try:
        if not settings()["autosave"]:
            return None
        preview = preview_from_tensor(image) if image is not None else None
        size = (int(image.shape[-2]), int(image.shape[-3])) if image is not None else None
        return record(images, settings_used, preview, size=size, input_frames=input_frames)
    except Exception:
        return None


def save_request(payload: object, preview=None) -> tuple[int, dict]:
    """A manual "Save current" from the node: images, settings, optional name."""
    if not isinstance(payload, dict):
        return 400, {"error": "Multi Stitch Images: expected a JSON object with images and settings."}
    try:
        entry = record(
            payload.get("images"), payload.get("settings"), preview,
            name=payload.get("name") or None,
            size=tuple(payload["size"]) if isinstance(payload.get("size"), list) and len(payload["size"]) == 2 else None,
        )
    except ValueError as exc:
        return 400, {"error": str(exc)}
    return 200, {"entry": entry, "storage": storage_summary()}
