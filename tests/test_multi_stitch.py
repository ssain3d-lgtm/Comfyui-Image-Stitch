import sys
import types

import pytest
import torch
from PIL import Image


# ComfyUI provides folder_paths at runtime. Stub only that host module so the
# backend can be unit-tested in a normal Python/GitHub Actions environment.
folder_paths = types.ModuleType("folder_paths")
folder_paths.get_input_directory = lambda: "."
folder_paths.get_temp_directory = lambda: "."
sys.modules.setdefault("folder_paths", folder_paths)

import multi_stitch as ms  # noqa: E402


@pytest.fixture(autouse=True)
def comfy_paths(tmp_path, monkeypatch):
    temp_dir = tmp_path / "temp"
    temp_dir.mkdir()
    monkeypatch.setattr(ms.folder_paths, "get_input_directory", lambda: str(tmp_path))
    monkeypatch.setattr(ms.folder_paths, "get_temp_directory", lambda: str(temp_dir))


def solid(rgb, h=2, w=2):
    image = torch.zeros((1, h, w, 3), dtype=torch.float32)
    image[:] = torch.tensor(rgb, dtype=torch.float32)
    return image


def assert_rgb(pixel, expected, atol=1e-6):
    assert torch.allclose(pixel, torch.tensor(expected, dtype=torch.float32), atol=atol)


def test_strip_directions_and_spacing():
    red = solid((1, 0, 0), h=2, w=2)
    green = solid((0, 1, 0), h=2, w=2)

    right = ms._compose([red, green], "strip", "right", False, 3, 1, "custom", "#336699")
    assert tuple(right.shape) == (1, 2, 5, 3)
    assert_rgb(right[0, 0, 0], (1, 0, 0))
    assert_rgb(right[0, 0, 4], (0, 1, 0))
    assert_rgb(right[0, 0, 2], (0x33 / 255, 0x66 / 255, 0x99 / 255), atol=1e-5)

    left = ms._compose([red, green], "strip", "left", False, 3, 0, "white", "#000000")
    assert_rgb(left[0, 0, 0], (0, 1, 0))
    assert_rgb(left[0, 0, -1], (1, 0, 0))

    down = ms._compose([red, green], "strip", "down", False, 3, 0, "white", "#000000")
    assert tuple(down.shape) == (1, 4, 2, 3)
    assert_rgb(down[0, 0, 0], (1, 0, 0))
    assert_rgb(down[0, -1, 0], (0, 1, 0))

    up = ms._compose([red, green], "strip", "up", False, 3, 0, "white", "#000000")
    assert_rgb(up[0, 0, 0], (0, 1, 0))
    assert_rgb(up[0, -1, 0], (1, 0, 0))


def test_grid_positions_are_unique_and_in_bounds():
    rows, cols, count = 2, 3, 5
    for direction in ("right", "left", "down", "up"):
        positions = [ms._grid_position(i, rows, cols, direction) for i in range(count)]
        assert len(set(positions)) == count
        assert all(0 <= r < rows and 0 <= c < cols for r, c in positions)


def test_grid_compose_shape_and_custom_background():
    a = solid((1, 0, 0), h=2, w=3)
    b = solid((0, 1, 0), h=4, w=2)
    out = ms._compose([a, b], "grid", "right", False, 2, 1, "custom", "#102030")
    assert tuple(out.shape) == (1, 4, 7, 3)
    assert_rgb(out[0, 3, 0], (0x10 / 255, 0x20 / 255, 0x30 / 255), atol=1e-5)


def test_estimate_matches_actual_compose():
    images = [solid((1, 0, 0), h=2, w=3), solid((0, 1, 0), h=4, w=2)]
    dims = [(3, 2), (2, 4)]
    for layout in ("strip", "grid"):
        for direction in ("right", "left", "down", "up"):
            for match in (False, True):
                out = ms._compose(images, layout, direction, match, 2, 1, "white", "#808080")
                expected_w, expected_h = ms._estimate_output_dimensions(dims, layout, direction, match, 2, 1)
                assert (out.shape[2], out.shape[1]) == (expected_w, expected_h)


def test_rotation_crop_dimensions_and_loading(tmp_path):
    path = tmp_path / "sample.png"
    Image.new("RGB", (100, 60), (255, 0, 0)).save(path)
    item = {
        "filename": "sample.png",
        "type": "input",
        "rotation": 90,
        "flip_h": True,
        "crop": {"x": 0.25, "y": 0.1, "w": 0.5, "h": 0.5},
    }
    dims = ms._item_output_dimensions(item)
    tensor = ms._load_image(item)
    assert dims == (30, 50)
    assert (tensor.shape[2], tensor.shape[1]) == dims


def test_unsafe_path_is_rejected(tmp_path):
    outside = tmp_path.parent / "outside.png"
    Image.new("RGB", (4, 4)).save(outside)
    with pytest.raises(ValueError, match="unsafe image path"):
        ms._safe_input_path({"filename": "../outside.png", "type": "input"})


def test_output_size_guard():
    width, height = ms._estimate_output_dimensions(
        [(8000, 8000)] * 4,
        "grid",
        "right",
        False,
        2,
        0,
    )
    assert (width, height) == (16000, 16000)
    with pytest.raises(ValueError, match="estimated output"):
        ms._validate_output_dimensions(width, height)


def test_empty_input_is_rejected():
    with pytest.raises(ValueError, match="at least one image"):
        ms._estimate_output_dimensions([], "strip", "right", True, 3, 0)
