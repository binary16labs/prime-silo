# Prime-Silo DevOps Guide

> Release pipeline, CI/CD workflows, and operational procedures

## Quick Reference

**Current version:** 1.2.4  
**Latest release:** https://github.com/binary16labs/prime-silo/releases/tag/v1.2.4

**Release workflow:** `.github/workflows/release-desktop.yml`  
**Release script:** `scripts/manage-release.js` (or `manage-release.ps1`)

---

## Release Process (Step-by-Step)

### Prerequisites
- All changes committed to `main` branch
- All documentation updated
- No uncommitted changes in working directory

### Step 1: Verify Branch State

```bash
cd prime-silo
git status                    # Should show: "nothing to commit, working tree clean"
git log --oneline -5         # Check recent commits
```

### Step 2: Create Release Commit and Tag

Use the managed release script (NOT manual git tag):

```bash
# PowerShell (Windows)
.\scripts\manage-release.ps1 patch    # or: minor, major

# Bash (macOS/Linux)
node scripts/manage-release.js patch   # or: minor, major
```

**What this does:**
1. ✓ Reads current version from `package.json`
2. ✓ Bumps version (patch/minor/major)
3. ✓ Updates `package.json`
4. ✓ Creates release commit with message "Release: X.Y.Z"
5. ✓ Creates annotated git tag `vX.Y.Z`

**Output:**
```
📦 Creating patch release: 1.2.4
✓ Updated package.json to version 1.2.4
✓ Created commit for version 1.2.4
✓ Created tag v1.2.4

✅ Release prepared successfully!

Next step: Push the tag to trigger the release workflow
  git push origin v1.2.4
```

### Step 3: Push Both Commits AND Tag

⚠️ **CRITICAL:** Push the release commits to `main` first, then push the tag.

```bash
# Push the release commit to origin/main
git push origin main

# Push the tag to trigger CI/CD
git push origin vX.Y.Z
```

**Why this order matters:**
- The release workflow's `release_gate` job checks if the tag's commit is an ancestor of `origin/main`
- If the tag is pushed before the commits, the release gate will find the tag exists but its commit isn't on origin/main yet
- This causes the build jobs to be **skipped** ❌

**If you forget to push main first:**
- Manually trigger the workflow: `gh workflow run release-desktop.yml -f release_tag=vX.Y.Z`
- Or push main and let the tag's automatic trigger re-run the workflow

### Step 4: Monitor Build Workflow

The tag push automatically triggers `.github/workflows/release-desktop.yml`:

```bash
# Check workflow status
gh run list --workflow=release-desktop.yml --limit 1

# View detailed progress
gh run view <run-id>

# View a specific job
gh run view <run-id> --job <job-id>
```

**Workflow stages:**

1. **Prepare** (2-3 min) — Validates release, checks tag is on main, detects newer tags
2. **Build** (20-25 min) — Compiles for all 6 platforms in parallel:
   - Windows x64
   - Windows ARM64
   - macOS x64
   - macOS ARM64
   - Linux x64
   - Linux ARM64
3. **Publish** (2-3 min) — Creates GitHub Release, uploads all artifacts

**Total time:** ~30 minutes

### Step 5: Verify Release Published

Once workflow completes:

```bash
# Check release exists
gh release view vX.Y.Z

# Should show all assets and download links
```

Expected output:
- Release page created
- 12 assets uploaded:
  - 6 platform installers (.exe, .dmg, .AppImage)
  - 4 metadata files (auto-update manifests)
  - 2 update zips (for macOS)

---

## CI/CD Workflows

### release-desktop.yml

**Trigger:** Tag push matching `v*` pattern  
**Location:** `.github/workflows/release-desktop.yml`

**Jobs:**

1. **prepare** (ubuntu-latest)
   - Runs registry resolver test
   - Extracts version from tag
   - **Release gate** — prevents building if:
     - Tag doesn't exist
     - Tag not on origin/main
     - Newer tag already on main
   - Checks out the tag commit
   - Generates release notes via AI (requires OPENROUTER_API_KEY)

2. **build** (conditional: if prepare succeeds)
   - Runs on matrix of 6 platforms (parallel)
   - Each builds platform-specific binary
   - Uploads artifacts to GitHub Actions
   - Takes 1-4 minutes per platform

3. **publish** (conditional: if build succeeds)
   - Downloads all platform artifacts
   - Merges auto-update metadata
   - Creates or updates GitHub Release
   - Uploads artifacts to release

### snapshot-build.yml

**Trigger:** Push to main branch (auto on every commit)  
**Location:** `.github/workflows/snapshot-build.yml`

**Purpose:** Build latest main branch code for testing  
**Artifacts:** 30-day retention  
**Version:** `0.0.0-snapshot-<build-number>`

---

## Release Gate Logic

The `prepare` job has a release gate that decides if the build should proceed:

```bash
# Gate checks (in order):
1. Tag exists?                                    → skip if no
2. Tag is on origin/main (ancestor)?             → skip if no
3. Any newer tag on main after this tag?         → skip if yes
4. If all pass: should_release=true              → build proceeds
```

**Why might build jobs be skipped?**

| Reason | Solution |
|--------|----------|
| Tag doesn't exist | Create tag with `manage-release.js` |
| Tag not on origin/main | Push main branch: `git push origin main` |
| Newer tag found on main | Push all commits and tags, then re-trigger |

**If skipped, how to retry:**

```bash
# Option 1: Manual workflow dispatch (simpler)
gh workflow run release-desktop.yml -f release_tag=vX.Y.Z

# Option 2: Delete and recreate tag (use if tag is truly bad)
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
git push origin main                  # ensure commits pushed
node scripts/manage-release.js patch  # create new tag
git push origin v1.2.5                # push new tag
```

---

## Important Files

| File | Purpose | Notes |
|------|---------|-------|
| `package.json` | Version source | Updated by `manage-release.js` |
| `.github/workflows/release-desktop.yml` | Build pipeline | 6 platform matrix, ~30 min |
| `.github/workflows/snapshot-build.yml` | Dev builds | Auto on every commit |
| `scripts/manage-release.js` | Version bumping | Creates tag + commit |
| `scripts/manage-release.ps1` | Windows wrapper | Calls manage-release.js |
| `packaging/` | Desktop app code | Electron, tray, system integration |
| `packaging/platforms/` | Platform-specific build configs | Windows, macOS, Linux |

---

## Secrets & Environment Variables

**Required for release workflow:**

| Secret | Purpose | Used by |
|--------|---------|---------|
| `OPENROUTER_API_KEY` | Release notes generation | prepare job (optional) |
| `GITHUB_TOKEN` | Create/update releases | publish job |

**Secrets should be set in GitHub repository settings.**

**Optional environment variables:**

```bash
$env:BENNY_HMAC_KEY = "..."          # 64-char hex key for signing
$env:CUSTOMWARE_PATH = "..."         # Home directory
$env:OPENROUTER_API_KEY = "..."      # AI model for release notes
```

---

## Common Issues & Solutions

### Issue: Build jobs skipped

**Symptom:** Workflow completes but build jobs show "skipped"

**Cause:** Release gate set `should_release=false`

**Solution:**
```bash
# Check what the gate found
gh run view <run-id> --log 2>&1 | grep -i "skipping\|should_release"

# If tag not on main:
git push origin main

# Retry manually:
gh workflow run release-desktop.yml -f release_tag=vX.Y.Z
```

### Issue: Publish job fails with "no artifacts"

**Symptom:** Publish job fails saying artifacts weren't found

**Cause:** Build jobs didn't complete or didn't upload artifacts

**Solution:**
```bash
# Check build job logs
gh run view <run-id> --job <build-job-id> --log

# Re-run build if it failed:
gh run rerun <run-id> --failed
```

### Issue: GitHub Release not created

**Symptom:** Workflow passes but release page doesn't exist

**Cause:** Publish job skipped or failed silently

**Solution:**
```bash
# Check publish job
gh run view <run-id> --job <publish-job-id> --log

# Manually create release
gh release create vX.Y.Z --title "v1.2.4" --generate-notes
```

### Issue: Wrong version in package.json

**Symptom:** Version doesn't match tag

**Cause:** Manual edit of package.json instead of using `manage-release.js`

**Solution:**
```bash
# Revert to last good version
git checkout HEAD~1 package.json

# Use proper script
node scripts/manage-release.js patch
```

---

## Multi-Platform Build Details

### Build Environments

| Platform | Runner | Arch | Time | Output |
|----------|--------|------|------|--------|
| Windows x64 | windows-latest | x64 | 1-2 min | `.exe` |
| Windows ARM64 | windows-11-arm | arm64 | 3-5 min | `.exe` |
| macOS x64 | macos-15-intel | x64 | 3-4 min | `.dmg` |
| macOS ARM64 | macos-latest | arm64 | 2 min | `.dmg` |
| Linux x64 | ubuntu-latest | x64 | 1 min | `.AppImage` |
| Linux ARM64 | ubuntu-24.04-arm | arm64 | 1 min | `.AppImage` |

### Build Scripts

Each platform has a build script in `packaging/scripts/`:

- `windows-package.js` — Windows EXE installer
- `macos-package.js` — macOS DMG + auto-update ZIP
- `linux-package.js` — Linux AppImage + auto-update manifest

**To build locally:**

```bash
# Install dependencies
npm ci --prefix packaging

# Build Windows x64
node packaging/scripts/windows-package.js --arch x64

# Build all platforms (sequential)
for script in packaging/scripts/*-package.js; do
  node "$script" --arch x64 --arch arm64
done
```

---

## Testing Builds

### Snapshot Builds (for testing)

Snapshot builds run automatically on every commit to main:

```bash
# Find snapshot builds
gh run list --workflow=snapshot-build.yml --limit 5

# Download snapshot artifacts
gh run download <run-id> -D snapshot-artifacts
```

### Local Development Build

For local testing (not for release):

```bash
# Terminal 1: Start services
cd runtime && benny up && cd ..

# Terminal 2: Start server
npm ci --prefix server
node space serve CUSTOMWARE_PATH=$HOME/.benny

# Terminal 3: Build desktop app (for your platform only)
npm ci --prefix packaging
node packaging/scripts/windows-package.js --arch x64  # on Windows
# or
node packaging/scripts/macos-package.js --arch arm64   # on macOS
# or
node packaging/scripts/linux-package.js --arch x64    # on Linux
```

---

## Release Notes Generation

The `prepare` job auto-generates release notes using AI:

```bash
# In prepare job:
node packaging/scripts/release-notes.js \
  --current-tag v1.2.4 \
  --previous-tag v1.2.3
```

**Requirements:**
- `OPENROUTER_API_KEY` environment variable set
- Network access to OpenRouter API
- If API unavailable, release still publishes with empty notes

**To manually generate notes:**

```bash
# See what would be generated
node packaging/scripts/release-notes.js --current-tag v1.2.4 --previous-tag v1.2.3

# Commits between tags
git log v1.2.3..v1.2.4 --oneline
```

---

## Rollback Procedures

### Undo a Bad Release

```bash
# Delete the tag locally and on remote
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z

# Delete the GitHub Release
gh release delete vX.Y.Z --yes

# Revert the release commit on main
git revert <release-commit-hash>
git push origin main

# Create new release with fixed version
node scripts/manage-release.js patch  # bumps to next version
git push origin main --tags
```

### Keep Old Release, Create Fixed Tag

```bash
# If you want to keep old release and make a new one:

# Delete only the tag (keep the commit and release)
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z

# Revert the broken commit in new release commit
git revert <broken-release-commit>
git push origin main

# Create new tag with next version
node scripts/manage-release.js patch
git push origin main --tags
```

---

## Monitoring & Observability

### Check Recent Releases

```bash
# List last 5 releases
gh release list --limit 5

# View specific release
gh release view v1.2.4

# Check which commit is tagged
git log --oneline --all --graph -10
git tag -l --contains HEAD  # tags on current commit
```

### Monitor Workflow Health

```bash
# Recent workflow runs
gh run list --workflow=release-desktop.yml --limit 10

# Failed runs
gh run list --workflow=release-desktop.yml --status failure

# In-progress runs
gh run list --status in_progress

# View specific run in browser
gh run view <run-id> --web
```

### Check Build Artifacts

```bash
# List artifacts from a run
gh run view <run-id> --json artifacts

# Download all artifacts
gh run download <run-id> -D ./artifacts

# Check file sizes
ls -lh artifacts/*/
```

---

## Handoff Checklist for Next Agent

When handing off to the next agent:

- [ ] Verify current version in `package.json`
- [ ] Review latest release at GitHub releases page
- [ ] Check if any PRs are pending review
- [ ] Verify all branches are up-to-date with remote
- [ ] Confirm CI/CD workflows all passed
- [ ] Document any ongoing maintenance tasks
- [ ] List any known issues or tech debt

**To generate handoff summary:**

```bash
# Current state
git log --oneline -5
git status
gh release list --limit 3
gh run list --workflow=release-desktop.yml --limit 3
```

---

## See Also

- [RELEASE-QUICK-START.md](RELEASE-QUICK-START.md) — Quick reference
- [RELEASE.md](RELEASE.md) — Detailed release guide
- [SETUP-SUMMARY.md](SETUP-SUMMARY.md) — Configuration guide
- [CLI.md](CLI.md) — Command reference
- [scripts/README.md](scripts/README.md) — Script documentation
