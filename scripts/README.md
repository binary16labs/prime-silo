# Prime Silo Release Management Scripts

This directory contains scripts for managing versions, releases, and CI/CD workflows for Prime Silo.

## Release Manager

The release manager handles version bumping, tagging, and release preparation.

### Usage

```bash
# Using Node.js directly
node scripts/manage-release.js [command]

# Using PowerShell (Windows)
.\scripts\manage-release.ps1 [command]
```

### Commands

#### `init` - Initialize First Release
Initializes the project with version 1.0.0 as the first release.

```bash
node scripts/manage-release.js init
```

**Effects:**
- Sets version to 1.0.0 in `package.json`
- Creates a commit with the version bump
- Creates an annotated git tag `v1.0.0`
- Prints instructions for pushing the tag

#### `patch` - Create Patch Release
Bumps the patch version (e.g., 1.0.0 → 1.0.1).

```bash
node scripts/manage-release.js patch
```

#### `minor` - Create Minor Release
Bumps the minor version (e.g., 1.0.0 → 1.1.0).

```bash
node scripts/manage-release.js minor
```

#### `major` - Create Major Release
Bumps the major version (e.g., 1.0.0 → 2.0.0).

```bash
node scripts/manage-release.js major
```

#### `list` - List All Releases
Shows all available releases in version order.

```bash
node scripts/manage-release.js list
```

#### `current` - Show Current Version
Displays the current version from `package.json`.

```bash
node scripts/manage-release.js current
```

#### `help` - Show Help
Displays the help message.

```bash
node scripts/manage-release.js help
```

## Workflow

### Creating a Release

1. **Prepare the release:**
   ```bash
   node scripts/manage-release.js minor
   ```
   This will:
   - Update `package.json` with the new version
   - Create a commit
   - Create a git tag

2. **Push the tag to trigger the release workflow:**
   ```bash
   git push origin v1.1.0
   ```
   Or push all commits and tags:
   ```bash
   git push origin main --tags
   ```

3. **CI/CD Pipeline:**
   - The `release-desktop.yml` workflow automatically triggers when a tag is pushed
   - It builds the desktop application for all platforms (macOS, Windows, Linux)
   - Creates a GitHub release with the built artifacts
   - Publishes the artifacts to the release page

### Snapshot Builds

Snapshot builds are automatically created for every commit to `main` via the `snapshot-build.yml` workflow. These are:
- Built with version `0.0.0-snapshot-{build-number}`
- Available as workflow artifacts for 30 days
- Useful for testing the latest main branch changes

## Requirements

- Node.js >= 20
- Git
- For builds: npm dependencies installed (`npm ci`)

## Environment

Scripts run in the context of the project root. All paths are resolved relative to the `scripts` directory's parent (the project root).
