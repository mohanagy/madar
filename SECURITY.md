# Security Policy

## Supported versions

Security fixes are applied to the latest published `0.x` release line on `main`.

Older versions may not receive fixes.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for suspected security vulnerabilities.

Preferred reporting path:

1. Use GitHub's private vulnerability reporting / security advisory flow if it is enabled for this repository.
2. If private reporting is not enabled yet, contact the maintainer privately using the contact information available on the maintainer's GitHub profile before any public disclosure.

When reporting, include:

- affected version
- impact and attack surface
- reproduction steps or proof of concept
- any suggested mitigation if known

## What to expect

The goal is to:

- acknowledge reports quickly
- confirm severity and scope
- coordinate a fix before public disclosure when possible

Please avoid publishing exploit details until the maintainer has had a reasonable chance to investigate and patch the issue.

## Scope notes

Because `madar` can ingest local files, documents, and URLs, reports involving:

- unsafe path handling
- unsafe URL fetching
- code execution
- injection into generated outputs
- secret leakage from local corpora

are especially helpful and should be treated as security-relevant.
