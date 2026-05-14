python
#!/usr/bin/env python3
"""
Generate contributor documentation and GitHub issue templates.

Creates CONTRIBUTING.md, issue templates (bug, feature, benchmark, docs,
research/design), optionally updates README.md and CHANGELOG.md with a
roadmap reference, and updates the PR template.

All file operations are validated and protected against path traversal.
Exits with code 0 on success, 1 on failure.
"""

import argparse
import logging
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Union, Final
from urllib.parse import urlparse

# ----------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------
logger: logging.Logger = logging.getLogger(__name__)


def setup_logging(verbose: bool = False) -> None:
    """Configure logging level and format.

    Args:
        verbose: If True, set logging level to DEBUG; otherwise INFO.

    Returns:
        None
    """
    level: int = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


# ----------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------
_DEFAULT_ROADMAP_URL: Final[str] = "https://github.com/org/project/roadmap"
_CONTRIBUTING_FILE: Final[str] = "CONTRIBUTING.md"
_ISSUE_TEMPLATES_DIR: Final[str] = ".github/ISSUE_TEMPLATE"
_PULL_REQUEST_TEMPLATE_FILE: Final[str] = ".github/pull_request_template.md"
_README_FILE: Final[str] = "README.md"
_CHANGELOG_FILE: Final[str] = "CHANGELOG.md"

_ISSUE_TEMPLATE_FILES: Final[Dict[str, str]] = {
    "bug_report.md": "Bug Report",
    "feature_request.md": "Feature Request",
    "benchmark.md": "Benchmark",
    "docs.md": "Documentation",
    "research_design.md": "Research/Design",
}

_SAFE_FILE_NAME_RE: Final = "^[a-zA-Z0-9_.-]{1,100}$"
import re


# ----------------------------------------------------------------------
# Validation helpers
# ----------------------------------------------------------------------


def validate_url(url: str) -> bool:
    """Validate that a string is a properly formatted URL with scheme and netloc.

    Args:
        url: The URL string to validate.

    Returns:
        True if the URL is valid, False otherwise.

    Raises:
        ValueError: If url is not a string.
    """
    if not isinstance(url, str):
        raise ValueError("URL must be a string")
    try:
        parsed = urlparse(url)
        return bool(parsed.scheme and parsed.netloc)
    except Exception as exc:
        logger.debug("URL validation failed: %s", exc)
        return False


def validate_path(path: Path, must_exist: bool = False) -> bool:
    """Validate that a path is usable.

    Args:
        path: The path to validate.
        must_exist: If True, the path must already exist and be a directory.

    Returns:
        True if valid, False otherwise.

    Raises:
        TypeError: If path is not a Path object.
    """
    if not isinstance(path, Path):
        raise TypeError("path must be a Path object")
    if must_exist:
        if not path.exists():
            return False
        if not path.is_dir():
            return False
    return True


def _check_path_traversal(base_dir: Path, target_path: Path) -> None:
    """Ensure target_path is within base_dir to prevent path traversal.

    Resolves both paths and checks that the target starts with the base.

    Args:
        base_dir: The allowed base directory (should be absolute).
        target_path: The path to check.

    Raises:
        ValueError: If the resolved target path is not under the base directory.
    """
    resolved_base: Path = base_dir.resolve() if not base_dir.is_absolute() else base_dir
    try:
        resolved_base = resolved_base.resolve()
    except OSError as exc:
        raise ValueError(f"Cannot resolve base directory {base_dir}: {exc}")
    resolved_target: Path = target_path.resolve()
    try:
        resolved_target.relative_to(resolved_base)
    except ValueError:
        raise ValueError(
            f"Path traversal detected: {target_path} is outside {resolved_base}"
        )


def validate_safe_filename(name: str) -> bool:
    """Check if a filename is safe (alphanumeric, dot, underscore, hyphen).

    Args:
        name: The filename to validate.

    Returns:
        True if the filename is safe, False otherwise.
    """
    if not isinstance(name, str):
        raise ValueError("Filename must be a string")
    return bool(re.match(_SAFE_FILE_NAME_RE, name))


# ----------------------------------------------------------------------
# Template builders
# ----------------------------------------------------------------------


def _build_contributing_md(roadmap_url: str, project_name: str = "Project") -> str:
    """Return the content for CONTRIBUTING.md.

    Args:
        roadmap_url: URL to the project roadmap. Must be a valid HTTP URL.
        project_name: The name of the project (used in headings).

    Returns:
        Markdown string for the contributing guide.

    Raises:
        ValueError: If roadmap_url is not a valid URL.
    """
    if not validate_url(roadmap_url):
        raise ValueError(f"Invalid roadmap URL: {roadmap_url}")

    return f"""# Contributing to {project_name}

Thank you for your interest in contributing! This guide covers local development,
testing, and the PR process.

## Local Development Setup

1. **Prerequisites**:
   - Node.js >= 18
   - npm >= 9
   - Git

2. **Clone and install**:

