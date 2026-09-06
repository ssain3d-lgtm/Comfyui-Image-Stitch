import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path

import torch
from PIL import Image


# ComfyUI supplies folder_paths at runtime. CI intentionally tests this custom
# node without installing all of ComfyUI, so stub only the host module first.
folder_paths = types.ModuleType("folder_paths")
folder_paths.get_input_directory = lambda: "."
folder_paths.get_temp_directory = lambda: "."
sys.modules["folder_paths"] = folder_paths

MODULE_PATH = Path(__file__).resolve().parents[1] / "multi_stitch.py"
spec = importlib.util.spec_from_file_location("multi_stitch_under_test", MODULE_PATH)
ms = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(ms)


def solid(rgb, h=2, w=2):
    image = torch.zeros((1, h, w, 3), dtype=torch.float32)
    image[:] = torch.tensor(rgb, dtype=torch.float32)
    return image


class MultiStitchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.temp_dir = self.root / "temp"
        self.temp_dir.mkdir()
        ms.folder_paths.get_input_directory = lambda: str(self.root)
        ms.folder_paths.get_temp_directory = lambda: str(self.temp_dir)

    def tearDown(self):
        self.temp.cleanup()

    def assertRgb(self, pixel, expected, atol=1e-6):
        self.assertTrue(
            torch.allclose(
                pixel,
                torch.tensor(expected, dtype=torch.float32),
                atol=atol,
            )
        )

    def test_strip_directions_and_spacing(self):
        red = solid((1, 0, 0), h=2, w=2)
        green = solid((0, 1, 0), h=2, w=2)

        right = ms._compose([red, green], "strip", "right", False, 3, 1, "custom", "#336699")
        self.assertEqual(tuple(right.shape), (1, 2, 5, 3))
        self.assertRgb(right[0, 0, 0], (1, 0, 0))
        self.assertRgb(right[0, 0, 4], (0, 1, 0))
        self.assertRgb(right[0, 0, 2], (0x33 / 255, 0x66 / 255, 0x99 / 255), atol=1e-5)

        left = ms._compose([red, green], "strip", "left", False, 3, 0, "white", "#000000")
        self.assertRgb(left[0, 0, 0], (0, 1, 0))
        self.assertRgb(left[0, 0, -1], (1, 0, 0))

        down = ms._compose([red, green], "strip", "down", False, 3, 0, "white", "#000000")
        self.assertEqual(tuple(down.shape), (1, 4, 2, 3))
        self.assertRgb(down[0, 0, 0], (1, 0, 0))
        self.assertRgb(down[0, -1, 0], (0, 1, 0))

        up = ms._compose([red, green], "strip", "up", False, 3, 0, "white", "#000000")
        self.assertRgb(up[0, 0, 0], (0, 1, 0))
        self.assertRgb(up[0, -1, 0], (1, 0, 0))

    def test_grid_positions_are_unique_and_in_bounds(self):
        rows, cols, count = 2, 3, 5
        for direction in ("right", "left", "down", "up"):
            with self.subTest(direction=direction):
                positions = [ms._grid_position(i, rows, cols, direction) for i in range(count)]
                self.assertEqual(len(set(positions)), count)
                self.assertTrue(all(0 <= r < rows and 0 <= c < cols for r, c in positions))

    def test_grid_compose_shape_and_custom_background(self):
        a = solid((1, 0, 0), h=2, w=3)
        b = solid((0, 1, 0), h=4, w=2)
        out = ms._compose([a, b], "grid", "right", False, 2, 1, "custom", "#102030")
        self.assertEqual(tuple(out.shape), (1, 4, 7, 3))
        self.assertRgb(out[0, 3, 0], (0x10 / 255, 0x20 / 255, 0x30 / 255), atol=1e-5)

    def test_estimate_matches_actual_compose(self):
        images = [solid((1, 0, 0), h=2, w=3), solid((0, 1, 0), h=4, w=2)]
        dims = [(3, 2), (2, 4)]
        for layout in ("strip", "grid"):
            for direction in ("right", "left", "down", "up"):
                for match in (False, True):
                    with self.subTest(layout=layout, direction=direction, match=match):
                        out = ms._compose(images, layout, direction, match, 2, 1, "white", "#808080")
                        expected_w, expected_h = ms._estimate_output_dimensions(
                            dims,
                            layout,
                            direction,
                            match,
                            2,
                            1,
                        )
                        self.assertEqual((out.shape[2], out.shape[1]), (expected_w, expected_h))

    def test_rotation_crop_dimensions_and_loading(self):
        path = self.root / "sample.png"
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
        self.assertEqual(dims, (30, 50))
        self.assertEqual((tensor.shape[2], tensor.shape[1]), dims)

    def test_unsafe_path_is_rejected(self):
        outside = self.root.parent / "outside.png"
        Image.new("RGB", (4, 4)).save(outside)
        try:
            with self.assertRaisesRegex(ValueError, "unsafe image path"):
                ms._safe_input_path({"filename": "../outside.png", "type": "input"})
        finally:
            outside.unlink(missing_ok=True)

    def test_output_size_guard(self):
        width, height = ms._estimate_output_dimensions(
            [(8000, 8000)] * 4,
            "grid",
            "right",
            False,
            2,
            0,
        )
        self.assertEqual((width, height), (16000, 16000))
        with self.assertRaisesRegex(ValueError, "estimated output"):
            ms._validate_output_dimensions(width, height)

    def test_empty_input_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "at least one image"):
            ms._estimate_output_dimensions([], "strip", "right", True, 3, 0)


if __name__ == "__main__":
    unittest.main()
