"""The gallery of compositions: recording, dedupe, listing, deletion and the
storage summary against a temporary input folder, then the six routes over a
real aiohttp application."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import test_multi_stitch as support  # installs the fake folder_paths module
from test_video_temp import load_module_with_routes

import multi_stitch_gallery as gallery

ms = support.ms

try:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
except ImportError:  # pragma: no cover - ComfyUI always ships aiohttp
    web = None


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
        # Different pictures, same 100 bytes each: the gallery now tells images
        # apart by content, so fixtures that differ only in name would be one.
        for name in ("a.png", "b.png", "c.png"):
            (self.root / "multi_stitch" / name).write_bytes(name[0].encode() * 100)

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

    def test_the_same_picture_under_a_new_name_is_the_same_composition(self):
        # Every upload gets a unique name, so pasting one photo a second time
        # used to leave two entries nothing could tell apart.
        (self.root / "multi_stitch" / "a_again.png").write_bytes(b"a" * 100)
        first = gallery.record([_item("a.png")], {"direction": "right"}, self.preview())
        again = gallery.record([_item("a_again.png")], {"direction": "right"}, None)
        self.assertEqual(again["id"], first["id"])
        self.assertEqual(again["uses"], 2)
        self.assertEqual(len(gallery.list_entries()), 1)
        # A different picture of the same size is still its own composition.
        other = gallery.record([_item("b.png")], {"direction": "right"}, None)
        self.assertNotEqual(other["id"], first["id"])
        # And one picture used twice is a composition of two images, not one:
        # duplicating an image on purpose has to survive this.
        pair = gallery.record([_item("a.png"), _item("a_again.png")], {"direction": "right"}, None)
        self.assertNotIn(pair["id"], (first["id"], other["id"]))
        self.assertEqual(len(gallery.list_entries()), 3)

    def test_an_entry_from_before_content_keys_is_matched_and_upgraded_once(self):
        entry = gallery.record([_item("a.png")], {"direction": "right"}, None)
        json_path, _ = gallery._entry_paths(entry["id"])
        stored = json.loads(json_path.read_text(encoding="utf-8"))
        stored.pop("key_v")
        stored["key"] = "a key from an older version"
        json_path.write_text(json.dumps(stored), encoding="utf-8")

        again = gallery.record([_item("a.png")], {"direction": "right"}, None)
        self.assertEqual(again["id"], entry["id"], "the old entry was recognised, not duplicated")
        upgraded = json.loads(json_path.read_text(encoding="utf-8"))
        self.assertEqual(upgraded["key_v"], gallery._KEY_VERSION, "rewritten, so it is hashed once and not per run")
        self.assertNotEqual(upgraded["key"], "a key from an older version")

    def test_an_image_that_cannot_be_read_falls_back_to_its_name(self):
        gone = gallery.record([_item("gone.png")], {}, None)
        other = gallery.record([_item("also-gone.png")], {}, None)
        self.assertNotEqual(gone["id"], other["id"], "nothing is known about them but their names")
        self.assertEqual(gallery.record([_item("gone.png")], {}, None)["id"], gone["id"])
        self.assertIsNone(gallery.file_fingerprint(_item("gone.png")))
        self.assertIsNone(gallery.file_fingerprint(_item("a.png", subfolder="elsewhere")), "not ours to hash")
        self.assertIsNone(gallery.file_fingerprint("a.png"), "an item, not a name")

    def test_a_file_is_hashed_once_and_again_when_it_moves(self):
        item = _item("a.png")
        path = self.root / "multi_stitch" / "a.png"
        stat = path.stat()
        before = gallery.file_fingerprint(item)
        self.assertTrue(before.startswith("100:"), before)
        path.write_bytes(b"z" * 100)
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        self.assertEqual(gallery.file_fingerprint(item), before, "same size and stamp: the cached hash stands")
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
        self.assertNotEqual(gallery.file_fingerprint(item), before, "the file moved, so it is read again")

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

    def test_loading_an_entry_marks_it_used_so_it_is_not_the_one_evicted(self):
        with patch.object(gallery.time, "time", lambda: 1_700_000_000.0):
            first = gallery.record([_item("a.png")], {}, None)["id"]
            second = gallery.record([_item("b.png")], {}, None)["id"]
            self.assertEqual([e["id"] for e in gallery.list_entries()], [second, first])

            # Loading the older one is using it: it goes to the front.
            status, body = gallery.touch(first)
            self.assertEqual(status, 200)
            self.assertEqual([e["id"] for e in gallery.list_entries()], [first, second])
            self.assertGreater(body["entry"]["used"], body["entry"]["created"])

            # So a third entry pushes out the one nobody reached for.
            with patch.object(gallery, "_MAX_ENTRIES", 2):
                gallery.record([_item("c.png")], {}, None)
            remaining = [e["id"] for e in gallery.list_entries()]
        self.assertIn(first, remaining, "the entry that was loaded stayed")
        self.assertNotIn(second, remaining)

    def test_a_pinned_entry_sorts_first_and_the_cap_never_drops_it(self):
        with patch.object(gallery.time, "time", lambda: 1_700_000_000.0):
            first = gallery.record([_item("a.png")], {}, None)["id"]
            gallery.record([_item("b.png")], {}, None)
            status, body = gallery.pin(first, True)
            self.assertEqual((status, body["entry"]["pinned"]), (200, True))
            self.assertEqual([e["id"] for e in gallery.list_entries()][0], first, "a pin comes first")

            # Two more with room for two: the unpinned one goes, the pin stays.
            with patch.object(gallery, "_MAX_ENTRIES", 2):
                gallery.record([_item("c.png")], {}, None)
                gallery.record([_item("d.png")], {}, None)
            ids = [e["id"] for e in gallery.list_entries()]
        self.assertIn(first, ids, "the pinned entry survived the cap")
        self.assertEqual(len(ids), 2)

        status, body = gallery.pin(first, False)
        self.assertEqual(status, 200)
        self.assertNotIn("pinned", body["entry"], "unpinning lets it age out again")
        self.assertEqual(gallery.pin("../etc", True)[0], 400)
        self.assertEqual(gallery.pin("20990101-000000-abcdef", True)[0], 404)

    def test_pinning_everything_keeps_everything(self):
        """A pin means "keep this", so pins past the cap grow the gallery."""
        with patch.object(gallery, "_MAX_ENTRIES", 2):
            ids = [gallery.record([_item("a.png", rotation=r)], {}, None)["id"] for r in (0, 90)]
            for entry_id in ids:
                gallery.pin(entry_id, True)
            gallery.record([_item("a.png", rotation=180)], {}, None)
            remaining = [e["id"] for e in gallery.list_entries()]
        self.assertEqual(len(remaining), 3, "nothing could be evicted, so nothing was")
        for entry_id in ids:
            self.assertIn(entry_id, remaining)

    def test_touch_rejects_a_bad_id_and_reports_a_missing_one(self):
        self.assertEqual(gallery.touch("../etc")[0], 400)
        self.assertEqual(gallery.touch(None)[0], 400)
        self.assertEqual(gallery.touch("20990101-000000-abcdef")[0], 404)

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
        # A clock that never advances: time.time() moves in ~16 ms steps on
        # Windows, so four records can share one stamp and the least recently
        # used must still be the one recorded first, not whichever the folder
        # happened to list.
        with patch.object(gallery, "_MAX_ENTRIES", 3), patch.object(gallery.time, "time", lambda: 1_700_000_000.0):
            ids = [gallery.record([_item("a.png", rotation=r)], {}, None)["id"] for r in (0, 90, 180, 270)]
            # Every id must differ even within the same second.
            self.assertEqual(len(set(ids)), 4)
            remaining = [e["id"] for e in gallery.list_entries()]
        self.assertEqual(len(remaining), 3)
        self.assertNotIn(ids[0], remaining, "the least recently used entry was evicted")
        self.assertEqual(remaining, ids[:0:-1], "and the rest are most recently used first")

    def test_reuse_moves_an_entry_to_the_front_within_one_clock_step(self):
        with patch.object(gallery.time, "time", lambda: 1_700_000_000.0):
            first = gallery.record([_item("a.png")], {}, None)["id"]
            second = gallery.record([_item("b.png")], {}, None)["id"]
            self.assertEqual([e["id"] for e in gallery.list_entries()], [second, first])
            # Stitching the first composition again makes it the newest.
            gallery.record([_item("a.png")], {}, None)
            self.assertEqual([e["id"] for e in gallery.list_entries()], [first, second])

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


@support.requires(web is not None, "aiohttp is not installed")
class GalleryRouteTests(unittest.IsolatedAsyncioTestCase):
    """The six gallery routes over real HTTP: statuses, JSON and the guards."""

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "multi_stitch").mkdir()
        for name in ("a.png", "b.png"):
            (self.root / "multi_stitch" / name).write_bytes(b"x" * 100)
        self.routes = web.RouteTableDef()
        self.module = load_module_with_routes(self.routes)
        self.patches = [
            patch.object(self.module.folder_paths, "get_input_directory", lambda: str(self.root)),
            patch.object(self.module.folder_paths, "get_temp_directory", lambda: str(self.root)),
        ]
        for patcher in self.patches:
            patcher.start()
        app = web.Application()
        app.add_routes(self.routes)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        for patcher in self.patches:
            patcher.stop()
        self.temp.cleanup()

    async def get(self, path):
        response = await self.client.get(path)
        return response.status, await response.json()

    async def post(self, path, payload):
        response = await self.client.post(path, json=payload)
        return response.status, await response.json()

    async def test_save_list_rename_and_delete_round_trip(self):
        status, body = await self.get("/multi_stitch/gallery")
        self.assertEqual((status, body["entries"], body["settings"]), (200, [], {"autosave": True}))

        status, body = await self.post("/multi_stitch/gallery/save", {
            "images": [_item("a.png"), _item("b.png")], "settings": {"direction": "down"},
            "name": "Studio", "size": [800, 300],
        })
        self.assertEqual(status, 200)
        entry_id = body["entry"]["id"]
        self.assertEqual((body["entry"]["name"], body["entry"]["width"]), ("Studio", 800))
        self.assertEqual(body["storage"]["files"], 2)

        status, body = await self.post("/multi_stitch/gallery/rename", {"id": entry_id, "name": "Studio set"})
        self.assertEqual((status, body["entry"]["name"]), (200, "Studio set"))

        status, body = await self.get("/multi_stitch/gallery")
        self.assertEqual([e["name"] for e in body["entries"]], ["Studio set"])

        status, body = await self.post("/multi_stitch/gallery/delete", {"ids": [entry_id], "files": True, "keep": ["b.png"]})
        self.assertEqual((status, body["removed"], body["files_removed"]), (200, [entry_id], 1))
        self.assertFalse((self.root / "multi_stitch" / "a.png").exists())
        self.assertTrue((self.root / "multi_stitch" / "b.png").exists(), "the open workflow keeps b.png")

    async def test_settings_and_cleanup(self):
        status, body = await self.post("/multi_stitch/gallery/settings", {"autosave": False})
        self.assertEqual((status, body), (200, {"settings": {"autosave": False}}))
        self.assertEqual((await self.get("/multi_stitch/gallery"))[1]["settings"], {"autosave": False})

        status, body = await self.post("/multi_stitch/gallery/cleanup", {"keep": ["a.png"]})
        self.assertEqual((status, body["files_removed"], body["bytes_freed"]), (200, 1, 100))
        self.assertTrue((self.root / "multi_stitch" / "a.png").exists())
        self.assertFalse((self.root / "multi_stitch" / "b.png").exists())

    async def test_bad_requests_answer_4xx_with_a_message(self):
        for path, payload in (
            ("/multi_stitch/gallery/save", {"images": "nope"}),
            ("/multi_stitch/gallery/save", None),
            ("/multi_stitch/gallery/rename", {"id": "../etc/passwd", "name": "x"}),
            ("/multi_stitch/gallery/delete", {"ids": []}),
            ("/multi_stitch/gallery/delete", {"ids": ["../x"]}),
            ("/multi_stitch/gallery/settings", []),
        ):
            with self.subTest(path=path, payload=payload):
                status, body = await self.post(path, payload)
                self.assertEqual(status, 400)
                self.assertIn("error", body)
        status, body = await self.post("/multi_stitch/gallery/rename", {"id": "20990101-000000-abcdef", "name": "x"})
        self.assertEqual(status, 404)

    async def test_a_body_that_is_not_json_is_rejected_not_crashed(self):
        response = await self.client.post("/multi_stitch/gallery/save", data=b"not json")
        self.assertEqual(response.status, 400)
        self.assertEqual((await response.json())["error"][:20], "Multi Stitch Images:")
