# File should be renamed to repo_docs_generator.py (currently misnamed as CHANGELOG.md)
"""Automate creation of contributor documentation and issue templates."""

import logging
import os
import shutil
from pathlib import Path
from typing import Optional

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


class RepoDocsGenerator:
    """Generate/update contribution docs, issue templates, and CHANGELOG."""

    def __init__(self, repo_root: Path, doc_templates: Optional[dict] = None) -> None:
        self.root = repo_root.resolve()
        if not self.root.is_dir():
            raise ValueError(f"Repository root {self.root} does not exist or is not a directory.")
        self.changelog_path = self.root / "CHANGELOG.md"
        self.contributing_path = self.root / "CONTRIBUTING.md"
        self.readme_path = self.root / "README.md"
        self.issues_dir = self.root / ".github/ISSUE_TEMPLATE"
        self.pr_template_path = self.root / ".github/PULL_REQUEST_TEMPLATE.md"
        self.backup_dir = self.root / ".docs_backup"
        self.doc_templates = doc_templates or {}

    def backup(self, path: Path) -> None:
        """Backup a file if it exists."""
        if not path.exists():
            return
        try:
            dest = self.backup_dir / path.relative_to(self.root)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(path), str(dest))
            logger.info("Backed up %s to %s", path, dest)
        except (OSError, shutil.Error) as e:
            logger.error("Failed to backup %s: %s", path, e)
            raise

    def update_changelog(self, entries: Optional[list] = None) -> None:
        """Add entry under Unreleased about contributor guide and issue templates."""
        self.backup(self.changelog_path)
        new_items = (
            "- Added CONTRIBUTING.md with setup, testing, and PR checklist.\n"
            "- Added issue templates (bug, feature, benchmark, docs, research).\n"
            "- Updated PR template to align with new contribution process.\n"
            "- Added link to roadmap in contributing docs.\n\n"
        )
        try:
            if self.changelog_path.exists():
                existing = self.changelog_path.read_text(encoding="utf-8")
                lines = existing.splitlines(keepends=True)
                unreleased_idx = -1
                for i, line in enumerate(lines):
                    if line.startswith("## Unreleased"):
                        unreleased_idx = i
                        break
                if unreleased_idx >= 0:
                    insert_idx = unreleased_idx + 1
                    while insert_idx < len(lines) and not lines[insert_idx].startswith("## "):
                        insert_idx += 1
                    lines.insert(insert_idx, new_items)
                    self.changelog_path.write_text("".join(lines), encoding="utf-8")
                    logger.info("Updated existing Unreleased section in CHANGELOG")
                else:
                    content = "# Changelog\n\n## Unreleased\n\n" + new_items + existing
                    self.changelog_path.write_text(content, encoding="utf-8")
                    logger.info("Added new Unreleased section at top of CHANGELOG")
            else:
                content = "# Changelog\n\n## Unreleased\n\n" + new_items
                self.changelog_path.write_text(content, encoding="utf-8")
                logger.info("Created CHANGELOG.md")
        except OSError as e:
            logger.error("Failed to update CHANGELOG.md: %s", e)
            raise

    def create_contributing(self) -> None:
        """Create CONTRIBUTING.md with required sections."""
        self.backup(self.contributing_path)
        project_name = self.doc_templates.get("project_name", "Your Project")
        content = (
            f"# Contributing to {project_name}\n\n"
            "Thank you for your interest in contributing! Please review this guide.\n\n"
            "## Local Setup\n\n"
            "1. Clone the repository.\n"
            "2. Install dependencies (refer to project-specific instructions).\n"
            "3. Run `npm install` (if applicable).\n"
            "4. Build: `npm run build`.\n\n"
            "## Testing\n\n"
            "Run `npm run test:run` for tests and `npm run typecheck` for type checking.\n\n"
            "## Pull Request Checklist\n\n"
            "- [ ] Code follows existing style.\n"
            "- [ ] All tests pass.\n"
            "- [ ] Types are correct (`npm run typecheck`).\n"
            "- [ ] Build succeeds (`npm run build`).\n"
            "- [ ] Documentation updated (if applicable).\n"
            "- [ ] No private corpora or secrets included.\n\n"
            "## Non-Goals\n\n"
            "- Avoid adding heavy governance processes.\n"
            "- Do not require contributors to run paid benchmarks.\n"
            "- Never include proprietary data or secrets.\n\n"
            "## Roadmap\n\n"
            "See our [roadmap](https://github.com/org/project/roadmap) for upcoming work.\n"
        )
        try:
            self.contributing_path.write_text(content, encoding="utf-8")
            logger.info("Created %s", self.contributing_path)
        except OSError as e:
            logger.error("Failed to create CONTRIBUTING.md: %s", e)
            raise

    # Additional methods (create_issue_templates, etc.) omitted for brevity but would follow same pattern
