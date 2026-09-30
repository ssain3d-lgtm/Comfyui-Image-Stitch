"""scripts/version_changed.py: when a push is worth publishing.

The script decides whether the registry gets a release, so it is tested against
real git history: a repository is built in a temporary folder and the script is
run the way the workflow runs it, with the commit a push started from and the
one it ended on.
"""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "version_changed.py"
NO_COMMIT = "0" * 40


def pyproject(version, description="a node"):
    return f'[project]\nname = "demo"\ndescription = "{description}"\nversion = "{version}"\n'


class VersionChangedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git("init", "-q", "-b", "main")

    def git(self, *args):
        result = subprocess.run(
            ["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", *args],
            cwd=self.repo, capture_output=True, text=True, encoding="utf-8", check=True,
        )
        return result.stdout.strip()

    def commit(self, text=None, *, name="pyproject.toml", message="change"):
        """A commit that writes `text` to a file (pyproject.toml by default)."""
        (self.repo / name).write_text(text if text is not None else f"{message}\n", encoding="utf-8")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)
        return self.git("rev-parse", "HEAD")

    def run_script(self, *args):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=self.repo, capture_output=True, text=True, encoding="utf-8", check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        # stdout is exactly what a workflow appends to $GITHUB_OUTPUT.
        pairs = dict(line.split("=", 1) for line in result.stdout.splitlines())
        return pairs, result.stderr

    def test_a_bump_is_a_change_and_says_which_version(self):
        before = self.commit(pyproject("1.0.0"))
        after = self.commit(pyproject("1.0.1"))
        pairs, why = self.run_script(before, after)
        self.assertEqual(pairs, {"changed": "true", "version": "1.0.1"})
        self.assertIn("1.0.0 to 1.0.1", why)

    def test_other_edits_to_pyproject_are_not_a_release(self):
        before = self.commit(pyproject("1.0.0"))
        after = self.commit(pyproject("1.0.0", description="a better description"))
        pairs, why = self.run_script(before, after)
        self.assertEqual(pairs, {"changed": "false", "version": "1.0.0"})
        self.assertIn("nothing to publish", why)

    def test_a_push_without_pyproject_changes_is_not_a_release(self):
        before = self.commit(pyproject("2.3.4"))
        after = self.commit(message="docs", name="README.md")
        self.assertEqual(self.run_script(before, after)[0], {"changed": "false", "version": "2.3.4"})

    def test_the_bump_need_not_be_the_last_commit_of_the_push(self):
        """A push carries every commit since `before`; only comparing the ends sees the bump."""
        before = self.commit(pyproject("1.0.0"))
        self.commit(pyproject("1.1.0"), message="bump")
        self.commit(message="docs after the bump", name="README.md")
        after = self.commit(message="more docs", name="CHANGELOG.md")
        pairs, _ = self.run_script(before, after)
        self.assertEqual(pairs, {"changed": "true", "version": "1.1.0"})
        # Looking at the last commit alone would have missed it.
        self.assertEqual(self.run_script(f"{after}~1", after)[0]["changed"], "false")

    def test_a_bump_undone_within_the_push_is_no_change(self):
        before = self.commit(pyproject("1.0.0"))
        self.commit(pyproject("1.0.1"), message="bump")
        after = self.commit(pyproject("1.0.0"), message="back")
        self.assertEqual(self.run_script(before, after)[0]["changed"], "false")

    def test_a_first_push_or_a_manual_run_publishes(self):
        self.commit(pyproject("1.0.0"))
        for before in (NO_COMMIT, ""):
            pairs, why = self.run_script(before, "HEAD")
            self.assertEqual(pairs, {"changed": "true", "version": "1.0.0"}, repr(before))
            self.assertIn("no earlier commit", why)
        # No arguments at all: HEAD, compared with nothing.
        self.assertEqual(self.run_script()[0]["changed"], "true")

    def test_a_commit_this_clone_never_had_is_treated_as_new(self):
        """After a force-push `before` may be gone; the registry refuses a duplicate, so say yes."""
        self.commit(pyproject("1.0.0"))
        pairs, why = self.run_script("1" * 40, "HEAD")
        self.assertEqual(pairs, {"changed": "true", "version": "1.0.0"})
        self.assertIn("could not be read", why)

    def test_a_pyproject_that_appears_in_the_push_is_treated_as_new(self):
        before = self.commit(message="readme", name="README.md")
        after = self.commit(pyproject("3.0.0"))
        pairs, why = self.run_script(before, after)
        self.assertEqual(pairs, {"changed": "true", "version": "3.0.0"})
        self.assertIn("could not be read", why)

    def test_no_version_after_the_push_means_nothing_to_publish(self):
        before = self.commit(pyproject("1.0.0"))
        after = self.commit('[project]\nname = "demo"\ndynamic = ["version"]\n')
        pairs, why = self.run_script(before, after)
        self.assertEqual(pairs, {"changed": "false", "version": ""})
        self.assertIn("declares no version", why)

    def test_it_reads_the_version_line_not_a_lookalike(self):
        tricky = '[project]\nname = "demo"\n# version = "9.9.9"\n[tool.other]\nrequires-version = "8.8.8"\nversion = "1.2.3"\n'
        before = self.commit(tricky)
        after = self.commit(tricky.replace("1.2.3", "1.2.4"))
        self.assertEqual(self.run_script(before, after)[0], {"changed": "true", "version": "1.2.4"})

    def test_too_many_arguments_is_a_usage_error_not_a_guess(self):
        self.commit(pyproject("1.0.0"))
        result = subprocess.run([sys.executable, str(SCRIPT), "a", "b", "c"], cwd=self.repo, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "", "nothing a workflow could mistake for an answer")


if __name__ == "__main__":
    unittest.main()
