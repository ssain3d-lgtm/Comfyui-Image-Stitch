"""The gallery of compositions: recording, dedupe, listing, deletion and the
storage summary, all against a temporary input folder."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import test_multi_stitch as support  # installs the fake folder_paths module

import multi_stitch_gallery as gallery

ms = support.ms


def _item(name, **extra):
    return {"filename": name, "subfolder": "multi_stitch", "type": "input", "crop": {"x": 0, "y": 0, "w": 1, "h": 1},
            "rotation": 0, "flip_h": False, "flip_v": False, **extra}


class GalleryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "multi_stitch").mkdir()
        self.patch = patch.object(gallery.folder_paths, "get_input_directory", lambda: str(self.root))
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.addCleanup(self.temp.cleanup)
        for name in ("a.png", "b.png", "c.png"):
            (self.root / "multi_stitch" / name).write_bytes(b"x" * 100)

    def preview(self):
        from PIL import Image
        return Image.new("RGB", (800, 300), (10, 200, 90))

    def test_record_writes_an_entry_with_a_bounded_preview(self):
        entry = gallery.record([_item("a.png"), _item("b.png")], {"direction": "right", "spacing_width": 3, "unknown": 1},
                               self.preview(), size=(800, 300))
        json_path, jpg_path = gallery._entry_paths(entry["id"])
        self.assertTrue(json_path.is_file() and jpg_path.is_file())
        stored = json.loads(json_path.read_text(encoding="utf-8"))
        self.assertEqual([i["filename"] for i in stored["images"]], ["a.png", "b.png"])
        self.assertEqual(stored["settings"], {"direction": "right", "spacing_width": 3}, "only known settings are kept")
        self.assertEqual((stored["width"], stored["height"]), (800, 300))
        self.assertNotIn("preview", stored)
        from PIL import Image
        with Image.open(jpg_path) as image:
            self.assertEqual(max(image.size), gallery._PREVIEW_SIDE)
        self.assertTrue(entry["preview"])

    def test_the_same_composition_is_recorded_once_and_counted(self):
        first = gallery.record([_item("a.png")], {"direction": "right"}, self.preview())
        again = gallery.record([_item("a.png")], {"direction": "right"}, None)
        self.assertEqual(first["id"], again["id"])
        self.assertEqual(again["uses"], 2)
        self.assertGreaterEqual(again["used"], first["used"])
        # A different crop, order or setting is a different composition.
        other = gallery.record([_item("a.png", rotation=90)], {"direction": "right"}, None)
        self.assertNotEqual(other["id"], first["id"])
        self.assertEqual(len(gallery.list_entries()), 2)

    def test_listing_is_most_recently_used_first_and_skips_junk(self):
        old = gallery.record([_item("a.png")], {"direction": "right"}, None)
        new = gallery.record([_item("b.png")], {"direction": "right"}, None)
        json_path, _ = gallery._entry_paths(old["id"])
        data = json.loads(json_path.read_text())
        data["used"] -= 100
        json_path.write_text(json.dumps(data))
        (gallery._gallery_dir() / "broken.json").write_text("{not json")
        (gallery._gallery_dir() / "bad id!.json").write_text("{}")
        listing = gallery.listing()
        self.assertEqual([e["id"] for e in listing["entries"]], [new["id"], old["id"]])
        self.assertEqual(listing["storage"]["entries"], 2)

    def test_names_are_cleaned_and_renamable(self):
        entry = gallery.record([_item("a.png")], {}, None, name="  my \x00 comp\n osition  " + "x" * 200)
        self.assertTrue(entry["name"].startswith("my comp osition"))
        self.assertLessEqual(len(entry["name"]), gallery._NAME_LIMIT)
        status, body = gallery.rename(entry["id"], "Studio set")
        self.assertEqual((status, body["entry"]["name"]), (200, "Studio set"))
        self.assertEqual(gallery.rename("../etc", "x")[0], 400)
        self.assertEqual(gallery.rename("20990101-000000-abcdef", "x")[0], 404)

    def test_rejects_junk_input(self):
        with self.assertRaises(ValueError):
            gallery.record("nope", {}, None)
        with self.assertRaises(ValueError):
            gallery.record([{"filename": "../x.png"}], {}, None)
        with self.assertRaises(ValueError):
            gallery.record([], {}, None)
        self.assertEqual(gallery.save_request("nope")[0], 400)
        self.assertEqual(gallery.save_request({"images": [], "settings": {}})[0], 400)
        self.assertEqual(gallery.delete([], False)[0], 400)
        self.assertEqual(gallery.delete(["../x"], False)[0], 400)

    def test_delete_entry_keeps_files_unless_asked_and_never_touches_used_ones(self):
        shared = gallery.record([_item("a.png"), _item("b.png")], {"direction": "right"}, None)
        other = gallery.record([_item("b.png")], {"direction": "down"}, None)
        status, body = gallery.delete([shared["id"]], delete_files=False)
        self.assertEqual((status, body["removed"], body["files_removed"]), (200, [shared["id"]], 0))
        self.assertTrue((self.root / "multi_stitch" / "a.png").exists())

        shared = gallery.record([_item("a.png"), _item("b.png"), _item("c.png")], {"direction": "right"}, None)
        status, body = gallery.delete([shared["id"]], delete_files=True, keep=["c.png"])
        self.assertEqual(status, 200)
        self.assertFalse((self.root / "multi_stitch" / "a.png").exists(), "only this entry used a.png")
        self.assertTrue((self.root / "multi_stitch" / "b.png").exists(), "another entry still uses b.png")
        self.assertTrue((self.root / "multi_stitch" / "c.png").exists(), "an open node uses c.png")
        self.assertEqual((body["files_removed"], body["bytes_freed"]), (1, 100))
        self.assertEqual([e["id"] for e in gallery.list_entries()], [other["id"]])
        self.assertEqual(gallery.delete([shared["id"]], False)[1]["missing"], [shared["id"]])

    def test_cleanup_removes_only_unreferenced_files(self):
        gallery.record([_item("a.png")], {}, None)
        (self.root / "multi_stitch" / "sub").mkdir()
        (self.root / "multi_stitch" / "sub" / "d.png").write_bytes(b"y")
        summary = gallery.storage_summary()
        self.assertEqual((summary["files"], summary["unreferenced_files"], summary["unreferenced_bytes"]), (3, 2, 200))
        status, body = gallery.cleanup(keep=["b.png"])
        self.assertEqual((status, body["files_removed"], body["bytes_freed"]), (200, 1, 100))
        self.assertEqual(sorted(p.name for p in (self.root / "multi_stitch").iterdir()),
                         ["a.png", "b.png", "gallery", "sub"], "kept: referenced, in keep, folders")

    def test_gallery_is_capped_at_max_entries(self):
        with patch.object(gallery, "_MAX_ENTRIES", 3):
            ids = [gallery.record([_item("a.png", rotation=r)], {}, None)["id"] for r in (0, 90, 180, 270)]
            # Every id must differ even within the same second.
            self.assertEqual(len(set(ids)), 4)
            remaining = [e["id"] for e in gallery.list_entries()]
        self.assertEqual(len(remaining), 3)
        self.assertNotIn(ids[0], remaining, "the least recently used entry was evicted")

    def test_preview_from_tensor_reduces_with_area_averaging(self):
        import torch
        image = torch.zeros(1, 300, 1200, 3)
        image[:, :, :600, 0] = 1.0  # left half red
        preview = gallery.preview_from_tensor(image)
        self.assertEqual(preview.size, (gallery._PREVIEW_SIDE, 96))
        self.assertEqual(preview.getpixel((10, 40)), (255, 0, 0))
        self.assertEqual(preview.getpixel((370, 40)), (0, 0, 0))
        small = gallery.preview_from_tensor(torch.ones(1, 20, 30, 3))
        self.assertEqual(small.size, (30, 20), "a small result is not upscaled")

    def test_settings_default_to_autosave_and_survive_a_write(self):
        self.assertEqual(gallery.settings(), {"autosave": True})
        self.assertEqual(gallery.listing()["settings"], {"autosave": True})
        self.assertEqual(gallery.set_settings({"autosave": False}), (200, {"settings": {"autosave": False}}))
        self.assertEqual(gallery.settings(), {"autosave": False})
        self.assertEqual(gallery.set_settings({"unrelated": 1})[1], {"settings": {"autosave": False}}, "only known keys change")
        self.assertEqual(gallery.set_settings("nope")[0], 400)
        gallery._settings_path().write_text("{not json")
        self.assertEqual(gallery.settings(), {"autosave": True}, "an unreadable file falls back to the default")
        self.assertEqual(gallery.list_entries(), [], "settings.json is not an entry")

    def test_record_run_follows_the_autosave_setting_and_never_raises(self):
        import torch
        image = torch.zeros(1, 30, 120, 3)
        entry = gallery.record_run([_item("a.png")], {"direction": "right", "unknown": 2}, image, input_frames=1)
        self.assertIsNotNone(entry)
        self.assertEqual((entry["width"], entry["height"], entry["input_frames"]), (120, 30, 1))
        self.assertTrue(gallery.entry_paths_exist(entry["id"])[1], "a run records a preview")
        gallery.set_settings({"autosave": False})
        self.assertIsNone(gallery.record_run([_item("b.png")], {}, image))
        self.assertEqual(len(gallery.list_entries()), 1)
        gallery.set_settings({"autosave": True})
        self.assertIsNone(gallery.record_run("not a list", {}, image), "a bad list is ignored, not raised")
        self.assertIsNone(gallery.record_run([_item("b.png")], {}, object()), "a bad image is ignored, not raised")
        self.assertEqual(len(gallery.list_entries()), 1)

    def test_image_file_paths_stay_inside_the_folder(self):
        self.assertIsNone(gallery._image_file("../a.png"))
        self.assertIsNone(gallery._image_file("gallery"))
        self.assertIsNone(gallery._image_file("missing.png"))
        self.assertEqual(gallery._image_file("a.png"), self.root / "multi_stitch" / "a.png")
        if os.name != "nt":
            outside = self.root / "outside.png"
            outside.write_bytes(b"z")
            (self.root / "multi_stitch" / "link.png").symlink_to(outside)
            self.assertIsNone(gallery._image_file("link.png"), "a link out of the folder is never deleted")


if __name__ == "__main__":
    unittest.main()
