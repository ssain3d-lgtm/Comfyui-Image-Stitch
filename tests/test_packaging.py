"""What ships around the node: tooltips, the Korean locale, the example
workflows, and the version bookkeeping. Each of these silently drifts when a
widget is added or renamed, so they are checked against INPUT_TYPES here."""
import importlib.util
import json
import re
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# ComfyUI supplies folder_paths at runtime; CI tests the node without it.
if "folder_paths" not in sys.modules:
    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_input_directory = lambda: "."
    folder_paths.get_temp_directory = lambda: "."
    sys.modules["folder_paths"] = folder_paths

spec = importlib.util.spec_from_file_location("multi_stitch_packaging", ROOT / "multi_stitch.py")
ms = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(ms)

# Core node types the example workflows may use besides this node.
CORE_TYPES = {"PreviewImage", "LoadImage", "ImageBatch", "Note"}


def node_inputs():
    """name -> (type, options) in the order ComfyUI creates the widgets."""
    inputs = ms.MultiStitchImages.INPUT_TYPES()
    entries = {}
    for section in ("required", "optional"):
        for name, spec_ in inputs[section].items():
            entries[name] = (spec_[0], spec_[1] if len(spec_) > 1 else {})
    return entries


def widget_names():
    return [name for name, (kind, _) in node_inputs().items() if kind != "IMAGE"]


class TooltipTests(unittest.TestCase):
    def test_every_input_and_output_has_a_tooltip(self):
        for name, (_, options) in node_inputs().items():
            self.assertTrue(options.get("tooltip", "").strip(), f"{name} has no tooltip")
        node = ms.MultiStitchImages
        self.assertEqual(len(node.OUTPUT_TOOLTIPS), len(node.RETURN_TYPES))
        self.assertTrue(all(t.strip() for t in node.OUTPUT_TOOLTIPS))


class KoreanLocaleTests(unittest.TestCase):
    def setUp(self):
        path = ROOT / "locales" / "ko" / "nodeDefs.json"
        self.node = json.loads(path.read_text(encoding="utf-8"))["MultiStitchImages"]

    def test_covers_every_input_and_output_exactly(self):
        entries = node_inputs()
        self.assertEqual(set(self.node["inputs"]), set(entries))
        for name, (kind, _) in entries.items():
            translated = self.node["inputs"][name]
            self.assertTrue(translated.get("name", "").strip(), f"{name} has no Korean name")
            self.assertTrue(translated.get("tooltip", "").strip(), f"{name} has no Korean tooltip")
            if isinstance(kind, (list, tuple)):
                self.assertEqual(set(translated.get("options", {})), set(kind), f"{name} options")
            else:
                self.assertNotIn("options", translated, f"{name} is not a choice")
        outputs = self.node["outputs"]
        self.assertEqual(list(outputs), [str(i) for i in range(len(ms.MultiStitchImages.RETURN_TYPES))])
        for translated in outputs.values():
            self.assertTrue(translated.get("name") and translated.get("tooltip"))
        self.assertTrue(self.node["description"].strip())

    def test_keeps_the_english_node_name_for_search(self):
        self.assertNotIn("display_name", self.node)


class ExampleWorkflowTests(unittest.TestCase):
    def workflows(self):
        files = sorted((ROOT / "example_workflows").glob("*.json"))
        self.assertGreaterEqual(len(files), 2)
        return [(path, json.loads(path.read_text(encoding="utf-8"))) for path in files]

    def test_links_are_consistent(self):
        for path, workflow in self.workflows():
            by_id = {node["id"]: node for node in workflow["nodes"]}
            self.assertEqual(len(by_id), len(workflow["nodes"]), f"{path.name}: duplicate node id")
            self.assertEqual(workflow["last_node_id"], max(by_id))
            self.assertEqual(workflow["last_link_id"], max(link[0] for link in workflow["links"]))
            self.assertEqual(workflow["version"], 0.4)
            self.assertTrue({node["type"] for node in by_id.values()} <= CORE_TYPES | {"MultiStitchImages"}, path.name)
            for link_id, src, src_slot, dst, dst_slot, link_type in workflow["links"]:
                source = by_id[src]["outputs"][src_slot]
                target = by_id[dst]["inputs"][dst_slot]
                self.assertEqual(source["type"], link_type, f"{path.name}: link {link_id}")
                self.assertEqual(target["type"], link_type, f"{path.name}: link {link_id}")
                self.assertIn(link_id, source["links"], f"{path.name}: link {link_id} missing from its source")
                self.assertEqual(target["link"], link_id, f"{path.name}: link {link_id} missing from its target")
            for node in by_id.values():
                for slot in node["inputs"]:
                    if slot["link"] is not None:
                        self.assertTrue(any(link[0] == slot["link"] for link in workflow["links"]), f"{path.name}: dangling input")
                for slot in node["outputs"]:
                    for link_id in slot["links"] or []:
                        self.assertTrue(any(link[0] == link_id for link in workflow["links"]), f"{path.name}: dangling output")

    def test_stitch_node_matches_input_types(self):
        entries = node_inputs()
        names = widget_names()
        for path, workflow in self.workflows():
            stitch = [node for node in workflow["nodes"] if node["type"] == "MultiStitchImages"]
            self.assertEqual(len(stitch), 1, path.name)
            node = stitch[0]
            values = node["widgets_values"]
            self.assertEqual(len(values), len(names), f"{path.name}: widgets_values must follow INPUT_TYPES")
            for name, value in zip(names, values):
                kind, options = entries[name]
                if isinstance(kind, (list, tuple)):
                    self.assertIn(value, kind, f"{path.name}: {name}")
                elif kind == "BOOLEAN":
                    self.assertIsInstance(value, bool, f"{path.name}: {name}")
                elif kind == "INT":
                    self.assertIsInstance(value, int, f"{path.name}: {name}")
                    self.assertTrue(options["min"] <= value <= options["max"], f"{path.name}: {name} out of range")
                elif kind == "STRING":
                    self.assertIsInstance(value, str, f"{path.name}: {name}")
            self.assertIsInstance(json.loads(values[names.index("images_json")]), list)
            self.assertEqual(node["properties"]["Node name for S&R"], "MultiStitchImages")
            self.assertEqual([slot["name"] for slot in node["inputs"]], ["images"])
            self.assertEqual([slot["name"] for slot in node["outputs"]], list(ms.MultiStitchImages.RETURN_NAMES))
            # The stitched image is previewed in every example.
            image_links = node["outputs"][0]["links"]
            self.assertTrue(image_links, path.name)


class VersionTests(unittest.TestCase):
    def test_version_changelog_and_readme_agree(self):
        pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
        version = re.search(r'^version = "([^"]+)"$', pyproject, re.M).group(1)
        changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
        newest = re.search(r"^## (\S+)", changelog, re.M).group(1)
        self.assertEqual(newest, version, "CHANGELOG.md must start with the current version")
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        major_minor = ".".join(version.split(".")[:2])
        self.assertIn(f"### {major_minor}에서 달라진 점", readme)
        self.assertIn(f"### What changed in {major_minor}", readme)

    def test_publish_workflow_targets_pyproject_and_needs_the_token(self):
        text = (ROOT / ".github" / "workflows" / "publish_action.yml").read_text(encoding="utf-8")
        self.assertIn('- "pyproject.toml"', text)
        self.assertIn("REGISTRY_ACCESS_TOKEN", text)
        self.assertIn("Comfy-Org/publish-node-action", text)


if __name__ == "__main__":
    unittest.main()
