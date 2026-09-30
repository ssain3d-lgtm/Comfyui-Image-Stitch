#!/usr/bin/env python3
"""Did a push change the version in pyproject.toml?

    python scripts/version_changed.py [BEFORE [AFTER]]

BEFORE is the commit a push started from (GitHub's `github.event.before`) and
AFTER the commit it ended on (default HEAD). The answer goes to stdout as
`changed=true|false` and `version=<AFTER's version>`, the format a workflow
step appends to $GITHUB_OUTPUT; the reasoning goes to stderr, where the job log
shows it.

It compares the two commits, not the last commit with its parent, because a
push can carry several commits and the one that bumped the version need not be
the last of them.

When it cannot tell, it says `true`. Publishing a version the registry already
has is refused by the registry and costs a red run; silently not publishing a
new one costs a release nobody notices is missing.
"""

from __future__ import annotations

import re
import subprocess
import sys

NO_COMMIT = "0" * 40  # what GitHub sends as `before` for the first push to a branch
VERSION = re.compile(r'^version\s*=\s*"([^"]+)"\s*$', re.MULTILINE)


def version_at(revision: str) -> str | None:
    """The version pyproject.toml declares at `revision`, or None if it has none there."""
    shown = subprocess.run(
        ["git", "show", f"{revision}:pyproject.toml"],
        capture_output=True, text=True, encoding="utf-8", check=False,
    )
    if shown.returncode != 0:
        return None
    found = VERSION.search(shown.stdout)
    return found.group(1) if found else None


def decide(before: str, after: str) -> tuple[bool, str | None, str]:
    """(changed, AFTER's version, why) — `why` is for the log."""
    current = version_at(after)
    if current is None:
        return False, None, f"pyproject.toml declares no version at {after[:12]}, so there is nothing to publish"
    if not before or before == NO_COMMIT:
        return True, current, f"no earlier commit to compare with, so {current} is treated as new"
    earlier = version_at(before)
    if earlier is None:
        return True, current, f"the version at {before[:12]} could not be read, so {current} is treated as new"
    if earlier == current:
        return False, current, f"the version is {current} both before and after this push; nothing to publish"
    return True, current, f"the version went from {earlier} to {current}"


def main(argv: list[str]) -> int:
    if len(argv) > 2:
        print(__doc__, file=sys.stderr)
        return 2
    before = argv[0] if argv else ""
    after = argv[1] if len(argv) > 1 else "HEAD"
    changed, version, why = decide(before, after)
    print(why, file=sys.stderr)
    print(f"changed={'true' if changed else 'false'}")
    print(f"version={version or ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
