# Prime Silo Release & Distribution Guide

This document describes the release process, CI/CD pipeline, and distribution workflow for Prime Silo.

## Overview

Prime Silo uses a two-track distribution system:

1. **Snapshot Builds**: Automatic builds from every commit to `main` branch
2. **Versioned Releases**: Tagged releases with full desktop builds for all platforms

## CI/CD Workflows

### 1. Snapshot Build Workflow (`snapshot-build.yml`)

Runs automatically on every push to `main` branch.

**What it does:**
- Builds desktop applications for macOS (x64, arm64), Windows (x64), and Linux (x64)
- Tags artifacts with snapshot version: `0.0.0-snapshot-{build-number}`
- Stores artifacts for 30 days in workflow artifacts storage
- Useful for testing latest changes without creating a formal release

**Artifacts available:**
- `snapshot-windows-x64`: Windows executable
- `snapshot-macos-x64`: macOS Intel build
- `snapshot-macos-arm64`: macOS Apple Silicon build
- `snapshot-linux-x64`: Linux AppImage

**Access:**
- View in GitHub Actions → Snapshot Build workflow
- Download artifacts from the specific workflow run

### 2. Release Desktop Workflow (`release-desktop.yml`)

Triggers when a git tag matching `v*` is pushed to the repository.

**What it does:**
- Validates the tag is on main branch history
- Generates release notes (with AI assistance if configured)
- Builds desktop applications for all platforms
- Creates/updates GitHub Release page
- Uploads all artifacts to the release

**Requirements:**
- Tag must match pattern: `v1.0.0`, `v2.1.0`, etc.
- Tag must point to a commit on main branch
- Latest tag is what gets released (prevents out-of-order releases)

**Platforms built:**
- macOS x64 (Intel)
- macOS arm64 (Apple Silicon)
- Windows x64
- Windows arm64
- Linux x64
- Linux arm64

## Release Process

### Initial Setup: First Release (v1.0.0)

If this is the first time setting up versioning:

```bash
cd prime-silo
node scripts/manage-release.js init
```

This:
1. Sets version to 1.0.0
2. Creates a commit
3. Creates tag v1.0.0
4. Shows you the next steps

Then push the tag:
```bash
git push origin v1.0.0
```

### Creating Subsequent Releases

#### Step 1: Prepare the Release

Use the release manager script:

```bash
# For patch releases (e.g., 1.0.0 → 1.0.1)
node scripts/manage-release.js patch

# For minor releases (e.g., 1.0.0 → 1.1.0)
node scripts/manage-release.js minor

# For major releases (e.g., 1.0.0 → 2.0.0)
node scripts/manage-release.js major
```

Each command:
- Updates `package.json` with new version
- Creates a commit with message "Release: X.Y.Z"
- Creates an annotated git tag
- Prints next steps

#### Step 2: Push to GitHub

```bash
# Push just the tag
git push origin v1.0.1

# Or push all commits and tags
git push origin main --tags
```

#### Step 3: Monitor the Release

The `release-desktop.yml` workflow will:
1. Validate the tag
2. Build for all platforms (takes ~30-45 minutes)
3. Create a GitHub Release page with artifacts
4. Provide download links

## Version Management

### Current Version

Check the current version:
```bash
node scripts/manage-release.js current
```

This reads from `package.json`.

### List All Releases

```bash
node scripts/manage-release.js list
```

Shows all existing version tags in the repository.

### Manual Version Bumps

The release manager handles all version updates automatically. Manual edits to `package.json` version are not recommended for release builds.

## Artifact Management

### Where Artifacts Go

**Snapshot builds:**
- GitHub Actions → Workflows → Snapshot Build → [specific run]
- Artifacts tab → Available for 30 days
- No GitHub Release created

**Versioned releases:**
- GitHub → Releases → [tag name]
- Artifacts available indefinitely
- Includes release notes and changelog

### Artifact Formats

For each platform:
- **macOS**: `.dmg` (installer), `.zip` (portable)
- **Windows**: `.exe` (NSIS installer), `.msi` (optional)
- **Linux**: `.AppImage` (portable)
- **All platforms**: Auto-updater metadata (`.json`)

### Download Locations

1. **GitHub Releases Page:**
   ```
   https://github.com/agent0ai/space-agent/releases/tag/vX.Y.Z
   ```

2. **Latest Release:**
   ```
   https://github.com/agent0ai/space-agent/releases/latest
   ```

3. **Direct artifact links:**
   Available in the release page assets

## Environment Variables

### Build Time Variables

These can be set to override version detection:

- `SPACE_APP_VERSION`: Explicit version string (e.g., "1.0.0")
- `SPACE_RELEASE_TAG`: Tag name (e.g., "v1.0.0")

### CI/CD Secrets (GitHub Actions)

Optional secrets for enhanced functionality:

- `OPENROUTER_API_KEY`: For AI-powered release notes
- `OPENROUTER_MODEL_NAME`: Model to use for notes generation
- `MACOS_CERT_P12`: Base64-encoded macOS signing certificate
- `MACOS_CERT_PASSPHRASE`: Certificate passphrase
- `APPLE_ID`: Apple ID for notarization
- `APPLE_PASSWORD`: App-specific password
- `APPLE_TEAM_ID`: Apple Team ID

## Troubleshooting

### Build Failures

1. Check the workflow logs: GitHub Actions → [workflow name] → [run]
2. Look for platform-specific issues
3. Most common: missing dependencies or environment configuration

### Release Not Triggering

Ensure:
- Tag follows pattern `v*` (e.g., `v1.0.0`)
- Tag exists on main branch: `git merge-base --is-ancestor <tag> main`
- Push the tag to GitHub: `git push origin <tag>`

### Old Release Being Built

The workflow prevents building older releases if a newer one exists. To rebuild:
1. Delete the newer tag locally and remotely
2. Push the older tag again

## Best Practices

1. **Always use the release manager script** - ensures consistency
2. **Test snapshot builds first** - before creating a versioned release
3. **Tag on main branch only** - avoid releasing from side branches
4. **Use semantic versioning** - major.minor.patch format
5. **Keep releases in order** - don't release v1.1.0 after v1.2.0

## Quick Reference

```bash
# Initialize first release
node scripts/manage-release.js init

# Create a new patch release
node scripts/manage-release.js patch
git push origin v1.0.1

# Create a new minor release
node scripts/manage-release.js minor
git push origin v1.1.0

# Create a new major release
node scripts/manage-release.js major
git push origin v2.0.0

# Check current version
node scripts/manage-release.js current

# List all releases
node scripts/manage-release.js list

# Get help
node scripts/manage-release.js help
```

## Related Files

- **Release workflows:** `.github/workflows/release-desktop.yml`, `.github/workflows/snapshot-build.yml`
- **Release scripts:** `packaging/scripts/release-*.js`
- **Version management:** `scripts/manage-release.js`
- **Package info:** `package.json` (version field)
