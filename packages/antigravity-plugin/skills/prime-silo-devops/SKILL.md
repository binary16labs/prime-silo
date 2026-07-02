---
name: prime-silo-devops
description: DevOps, SDLC, Tagging, and Release management instructions for Prime-Silo. Use this when asked to tag a new release, check CI/CD build status, or manage the SDLC.
---

# Prime-Silo DevOps & Release Management

Use this skill whenever you are tasked with managing the SDLC, triggering a new release, checking CI/CD workflows, or troubleshooting build pipelines for the `prime-silo` project.

## 1. Prerequisites for Releasing

Before creating a release, you MUST verify:

- All changes are committed and merged into the `main` branch.
- The working directory is completely clean (`git status` shows no uncommitted changes).
- All relevant documentation is updated.

## 2. Creating a Release (Tagging)

DO NOT use manual `git tag` or manually edit `package.json` to bump the version. You must use the managed release script.

**To create a release:**

```bash
# On Windows PowerShell
.\scripts\manage-release.ps1 <patch|minor|major>

# On macOS/Linux Bash
node scripts/manage-release.js <patch|minor|major>
```

_This script will automatically read the current version, bump it appropriately, update `package.json`, create a commit named "Release: X.Y.Z", and create an annotated git tag._

## 3. Pushing the Release

**CRITICAL PUSH ORDER**: You MUST push the release commit to `main` **before** pushing the tag. If you push the tag first, the release gate will skip the build jobs because the tag's commit isn't on `origin/main` yet!

```bash
# Step 1: Push the commit FIRST
git push origin main

# Step 2: Push the tag SECOND
git push origin vX.Y.Z
```

## 4. Monitoring the CI/CD Pipeline

Releases trigger `.github/workflows/release-desktop.yml`. Snapshot builds run automatically on every push to main via `.github/workflows/snapshot-build.yml`.

**To monitor workflow status:**

```bash
# Check workflow status
gh run list --workflow=release-desktop.yml --limit 1

# View detailed progress or a specific job
gh run view <run-id>
gh run view <run-id> --job <job-id>
```

A normal release build takes ~30 minutes to complete the matrix of 6 platforms (Windows x64/arm64, macOS x64/arm64, Linux x64/arm64).

## 5. Troubleshooting & Rollbacks

If a build job skips unexpectedly, check the release gate:

```bash
gh run view <run-id> --log 2>&1 | grep -i "skipping\|should_release"
```

**Common reasons for skips:**

- Tag doesn't exist.
- Tag commit is not on `origin/main` (You forgot to push `main` first).
- A newer tag was found.

**To retry a skipped build:**

```bash
# Push main if you forgot
git push origin main

# Retrigger the workflow
gh workflow run release-desktop.yml -f release_tag=vX.Y.Z
```

**To undo a bad release:**

```bash
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
gh release delete vX.Y.Z --yes
git revert <release-commit-hash>
git push origin main
```

## 6. Handoff Checklist

If you are handing off release management to another agent, provide them with:

- The current version (`node scripts/manage-release.js current`).
- The recent git log (`git log --oneline -5`).
- The status of recent releases (`gh release list --limit 3`).
- The status of recent CI runs (`gh run list --workflow=release-desktop.yml --limit 3`).
