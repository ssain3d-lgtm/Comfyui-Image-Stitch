"""What ships around the node: tooltips, the Korean locale, the example
workflows, the version bookkeeping, and the CI and release workflows. Each of
these silently drifts when a widget is added or renamed, so they are checked
against INPUT_TYPES here."""
import importlib.util
import json
import os
import re
import sys
import types
import unittest
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - exercised by the CI branch below
    yaml = None

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"

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
# ImageBatch is not among them on purpose: the examples show the inputs the node
# has now, one socket per picture, instead of joining pictures into a batch first.
CORE_TYPES = {"PreviewImage", "LoadImage", "ImageCrop", "Note"}

# A pinned action reference: owner/repo@<40 hex>.
PINNED_ACTION = re.compile(r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$")


def load_workflow(test, name):
    """A workflow file as data, or a skip when PyYAML is missing locally.

    Reading a workflow as YAML instead of searching it for substrings is the
    point of these tests: a pin that moved into a comment, or a job that grew a
    second install step, changes the text without changing the meaning.

    PyYAML is in requirements-ci.txt, so in CI a missing parser is a broken
    environment, not a reason to report green with the workflow checks skipped.
    """
    if yaml is None:
        if os.environ.get("CI"):
            test.fail("PyYAML is missing; requirements-ci.txt must install it for the workflow checks")
        test.skipTest("PyYAML is not installed")
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


def triggers(workflow):
    """The `on:` block. PyYAML reads the bare key `on` as the boolean True."""
    return workflow.get("on", workflow.get(True, {}))


def steps_of(job):
    return job.get("steps") or []


def run_lines(job):
    """Every shell command in a job, as one string per step."""
    return [str(step["run"]) for step in steps_of(job) if "run" in step]


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
        self.assertGreaterEqual(len(files), 3)
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
            for name, value in zip(names, values, strict=True):
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
            # The IMAGE sockets, in order: images, then images_2, images_3… with no
            # gap. (A workflow saved by ComfyUI also lists a socket for every
            # widget, and the node's spare socket after the last one in use.)
            used = [slot["name"] for slot in node["inputs"] if slot.get("type") == "IMAGE"]
            self.assertEqual(used, ["images"] + [f"images_{n}" for n in range(2, len(used) + 1)], path.name)
            self.assertLessEqual(len(used), ms._MAX_IMAGE_INPUTS, path.name)
            # The node shows as many numbered outputs as it holds pictures, so a
            # saved one may have fewer than the eight it declares — always a prefix.
            shown = [slot["name"] for slot in node["outputs"]]
            declared = list(ms.MultiStitchImages.RETURN_NAMES)
            self.assertEqual(shown, declared[:len(shown)], path.name)
            self.assertGreaterEqual(len(shown), 4, path.name)
            # The stitched image is previewed in every example.
            image_links = node["outputs"][0]["links"]
            self.assertTrue(image_links, path.name)


    def test_examples_were_saved_by_comfyui_so_slot_numbers_are_real(self):
        """ComfyUI numbers a node's inputs widgets included, so images_2 is not slot 1.

        An example that lists only the IMAGE sockets, with link slots counted
        among those alone, is consistent with itself and loads with its links on
        the wrong inputs — the third Load Image landing on match_image_size —
        and is refused when queued. Only a file saved by ComfyUI itself has the
        numbers right, and it is recognisable by listing a socket for every
        widget of the stitch node.
        """
        names = widget_names()
        for path, workflow in self.workflows():
            by_id = {node["id"]: node for node in workflow["nodes"]}
            stitch = next(n for n in workflow["nodes"] if n["type"] == "MultiStitchImages")
            listed = [slot["name"] for slot in stitch["inputs"] if "widget" in slot]
            self.assertEqual(listed, names, f"{path.name}: re-save it from ComfyUI; a hand-written socket list shifts the links")
            for link_id, _src, _src_slot, dst, dst_slot, link_type in workflow["links"]:
                target = by_id[dst]["inputs"][dst_slot]
                if link_type == "IMAGE":
                    self.assertNotIn("widget", target, f"{path.name}: link {link_id} lands on a widget socket")
                    self.assertEqual(target["type"], "IMAGE", f"{path.name}: link {link_id}")
                if by_id[dst]["type"] == "MultiStitchImages":
                    self.assertRegex(target["name"], r"^images(_[2-8])?$", f"{path.name}: link {link_id}")

    def test_a_wired_image_output_needs_output_cells(self):
        """image_N is one black pixel while output_cells is off; an example must not ship that."""
        names = widget_names()
        for path, workflow in self.workflows():
            node = next(n for n in workflow["nodes"] if n["type"] == "MultiStitchImages")
            cells_on = node["widgets_values"][names.index("output_cells")]
            wired = [slot["name"] for slot in node["outputs"] if slot["links"] and slot["name"].startswith("image_")]
            if wired:
                self.assertTrue(cells_on, f"{path.name} wires {wired} with output_cells off")

    def test_the_examples_are_the_ones_the_readme_names(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        for path, _ in self.workflows():
            self.assertIn(path.stem, readme, f"{path.name} is not described in the README")
        self.assertNotIn("grid-from-image-batch", readme)


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

    def test_package_json_version_matches_pyproject(self):
        # ComfyUI never reads package.json, but the frontend tests and the
        # registry release come from the same tree; two versions here is how a
        # release ends up half-done.
        pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
        version = re.search(r'^version = "([^"]+)"$', pyproject, re.M).group(1)
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(package["version"], version, "package.json must carry the pyproject.toml version")


class PublishWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.workflow = load_workflow(self, "publish_action.yml")
        self.job = self.workflow["jobs"]["publish-node"]
        self.publish_step = next(
            step for step in steps_of(self.job)
            if str(step.get("uses", "")).startswith("Comfy-Org/publish-node-action")
        )

    def test_a_push_never_starts_it_on_its_own(self):
        """It was once `on: push`, which raced the tests: CI red, and the registry published anyway."""
        on = triggers(self.workflow)
        self.assertNotIn("push", on)
        self.assertNotIn("pull_request", on)
        # Called by ci.yml once the tests have passed, or run by hand.
        self.assertEqual(sorted(on), ["workflow_call", "workflow_dispatch"])
        self.assertIn("REGISTRY_ACCESS_TOKEN", on["workflow_call"]["secrets"])
        self.assertEqual(on["workflow_call"]["inputs"]["before"]["default"], "")

    def test_it_publishes_only_when_the_version_changed(self):
        check = next(step for step in steps_of(self.job) if step.get("id") == "version")
        self.assertIn("scripts/version_changed.py", str(check["run"]))
        self.assertIn("inputs.before", str(check["env"]["BEFORE"]))
        # The script compares two commits, so the whole history must be there.
        checkout = next(step for step in steps_of(self.job) if str(step.get("uses", "")).startswith("actions/checkout"))
        self.assertEqual(checkout["with"]["fetch-depth"], 0)
        self.assertIn("steps.version.outputs.changed == 'true'", str(self.publish_step["if"]))

    def test_the_publish_action_is_pinned_to_a_commit(self):
        # This step is handed the registry token, so it must not be able to
        # change under us: a tag or a branch can be moved, a commit cannot.
        uses = self.publish_step["uses"]
        self.assertRegex(uses, PINNED_ACTION, f"{uses} must be pinned to a full 40-character commit SHA")

    def test_it_needs_the_token_and_skips_without_one(self):
        self.assertIn("REGISTRY_ACCESS_TOKEN", str(self.publish_step["with"]["personal_access_token"]))
        # A guard step decides, and the publish step is conditional on it, so a
        # fork without the secret gets a notice instead of a red run.
        guard = next(step for step in steps_of(self.job) if step.get("id") == "token")
        self.assertIn("REGISTRY_ACCESS_TOKEN", str(guard.get("env", {})))
        self.assertIn("steps.token.outputs.present", str(self.publish_step.get("if", "")))

    def test_the_script_it_runs_exists(self):
        self.assertTrue((ROOT / "scripts" / "version_changed.py").is_file())


class CIWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.workflow = load_workflow(self, "ci.yml")
        self.jobs = self.workflow["jobs"]

    def backend_jobs(self):
        """Jobs that run the Python test suite, by name."""
        found = {
            name: job for name, job in self.jobs.items()
            if any("unittest discover" in line for line in run_lines(job))
        }
        self.assertTrue(found, "no job runs the backend tests any more")
        return found

    def test_every_backend_job_installs_the_pinned_test_dependencies(self):
        # The ranges live in one file so Dependabot can see them and so two jobs
        # cannot drift onto different versions.
        for name, job in self.backend_jobs().items():
            self.assertTrue(
                any("requirements-ci.txt" in line for line in run_lines(job)),
                f"job {name} runs the backend tests without installing requirements-ci.txt",
            )

    def test_the_pip_cache_is_keyed_on_the_requirements_file(self):
        for name, job in self.backend_jobs().items():
            setup = next(
                step for step in steps_of(job)
                if str(step.get("uses", "")).startswith("actions/setup-python")
            )
            self.assertEqual(
                setup["with"].get("cache-dependency-path"), "requirements-ci.txt",
                f"job {name} caches pip against the wrong file",
            )


    def test_the_release_waits_for_every_other_job(self):
        """The registry must never receive a commit that turned CI red."""
        publish = self.jobs["publish"]
        others = set(self.jobs) - {"publish"}
        self.assertEqual(set(publish["needs"]), others, "a job the release does not wait for can fail unnoticed")
        self.assertEqual(publish["uses"], "./.github/workflows/publish_action.yml")
        condition = str(publish["if"])
        self.assertIn("github.event_name == 'push'", condition)
        self.assertIn("refs/heads/main", condition)
        # No status function: the implicit success() is what keeps a failed or
        # skipped job from being published over.
        for function in ("always()", "cancelled()", "failure()", "success()"):
            self.assertNotIn(function, condition)
        self.assertNotIn("continue-on-error", publish)
        self.assertIn("github.event.before", str(publish["with"]["before"]))
        self.assertIn("REGISTRY_ACCESS_TOKEN", str(publish["secrets"]))

    def test_no_test_job_can_fail_without_holding_the_release_back(self):
        for name, job in self.jobs.items():
            if name == "publish":
                continue
            self.assertNotIn("continue-on-error", job, f"{name} could fail and still let the release through")

    def test_nothing_else_handles_the_registry_token_or_publishes(self):
        for name, job in self.jobs.items():
            if name == "publish":
                continue
            text = yaml.safe_dump(job)
            self.assertNotIn("REGISTRY_ACCESS_TOKEN", text, name)
            self.assertNotIn("publish-node-action", text, name)

    def test_a_push_to_main_is_never_cancelled_by_a_later_one(self):
        """Each commit on main carries its own release; a newer push must not take it away."""
        concurrency = self.workflow["concurrency"]
        self.assertIsInstance(concurrency["cancel-in-progress"], str, "a plain true also cancels pushes to main")
        self.assertEqual(concurrency["cancel-in-progress"].strip(), "${{ github.event_name == 'pull_request' }}")
        self.assertIn("github.sha", concurrency["group"], "pushes share a group, so one run replaces another")


class RequirementsTests(unittest.TestCase):
    def test_requirements_txt_lists_pyav_for_comfyui_manager(self):
        path = ROOT / "requirements.txt"
        self.assertTrue(path.exists(), "requirements.txt is what ComfyUI-Manager installs")
        names = [
            re.split(r"[<>=!~\[; ]", line, maxsplit=1)[0].strip().lower()
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        self.assertIn("av", names, "server-side video decoding needs PyAV")

    def test_ci_requirements_cover_the_test_tooling(self):
        text = (ROOT / "requirements-ci.txt").read_text(encoding="utf-8")
        for package in ("numpy", "pillow", "torch", "av", "aiohttp", "coverage", "ruff", "pyyaml"):
            self.assertRegex(text, rf"(?mi)^{package}\b", f"requirements-ci.txt must pin {package}")


if __name__ == "__main__":
    unittest.main()
