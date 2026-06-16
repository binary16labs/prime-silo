# Prime Silo Release - Quick Start Guide

## ✅ What's Been Set Up

Your Prime Silo project now has a complete release and versioning system:

### 1. **Snapshot Build Pipeline** (`snapshot-build.yml`)
- Automatically builds executables for every commit to `main`
- Creates Windows, macOS (Intel + ARM), and Linux builds
- Artifacts available for 30 days in workflow storage
- Version: `0.0.0-snapshot-{build-number}`

### 2. **Release Pipeline** (`release-desktop.yml`)
- Triggers when you push a git tag matching `v*`
- Builds desktop apps for all 6 platform variants
- Creates GitHub Release page with artifacts
- Auto-generates release notes

### 3. **Release Manager Script**
- Located at: `scripts/manage-release.js` (Node.js)
- PowerShell wrapper: `scripts/manage-release.ps1`
- Handles version bumping and git tag creation

### 4. **Initial Release: v1.0.0**
- First version already created and tagged
- Ready to push to trigger the full release build

## 🚀 Next Steps

### Step 1: Push the Release Tag
```bash
# From the prime-silo directory
git push origin v1.0.0
```

This triggers the `release-desktop.yml` workflow which will:
- Build for Windows (x64, arm64)
- Build for macOS (Intel x64, Apple Silicon arm64)
- Build for Linux (x64, arm64)
- Create a GitHub Release page
- Upload all artifacts

**Expected duration:** 30-45 minutes

### Step 2: Monitor the Build
Go to: **GitHub → Actions → Release Desktop**

Once complete, your releases will be available at:
```
https://github.com/agent0ai/space-agent/releases/tag/v1.0.0
```

### Step 3: Create Future Releases

When you're ready for the next release:

```bash
# For bug fixes (1.0.0 → 1.0.1)
node scripts/manage-release.js patch
git push origin $(git describe --tags --exact-match HEAD)

# For new features (1.0.0 → 1.1.0)
node scripts/manage-release.js minor
git push origin $(git describe --tags --exact-match HEAD)

# For major changes (1.0.0 → 2.0.0)
node scripts/manage-release.js major
git push origin $(git describe --tags --exact-match HEAD)
```

Or use PowerShell on Windows:
```powershell
.\scripts\manage-release.ps1 minor
git push origin $(git describe --tags --exact-match HEAD)
```

## 📋 Release Manager Commands

Check `scripts/README.md` for full documentation, or:

```bash
node scripts/manage-release.js help
```

**Common commands:**
- `current` - Show current version
- `list` - List all releases
- `patch` / `minor` / `major` - Create new release
- `help` - Show help

## 📁 Files Created/Modified

**New workflows:**
- `.github/workflows/snapshot-build.yml` - Automatic snapshot builds
- `.github/workflows/release-desktop.yml` - (already existed) Release builds

**New scripts:**
- `scripts/manage-release.js` - Release management (Node.js)
- `scripts/manage-release.ps1` - Release management (PowerShell)
- `scripts/README.md` - Detailed script documentation

**Documentation:**
- `RELEASE.md` - Complete release guide
- `RELEASE-QUICK-START.md` - This file

**Modified:**
- `package.json` - Updated version to 1.0.0

## 🔍 Key Features

### Automatic Snapshot Builds
Every commit to `main` automatically builds executables:
- No manual action needed
- Artifacts available in Actions tab
- Great for testing latest code

### Smart Release Tagging
The release manager prevents common mistakes:
- Enforces semantic versioning
- Prevents duplicate tags
- Auto-commits version bump
- Clear instructions for next steps

### Multi-Platform Builds
Single tag push builds for:
- Windows x64 & arm64
- macOS Intel & Apple Silicon
- Linux x64 & arm64

## ⚙️ Configuration

### To customize:
See `RELEASE.md` for details on:
- Environment variables
- CI/CD secrets setup
- Auto-updater configuration
- Platform-specific settings

### Common customizations:
- Add signing certificates (see RELEASE.md)
- Enable AI-powered release notes (OPENROUTER_API_KEY)
- Configure auto-updater behavior
- Customize installer appearance

## 🎯 Typical Workflow

```
1. Make changes to main branch
   └─> Snapshot builds auto-trigger (check Actions tab)

2. When ready to release:
   node scripts/manage-release.js minor
   └─> Updates version, creates commit & tag

3. Push tag to GitHub:
   git push origin v1.1.0
   └─> Release workflow auto-triggers (40 min)

4. Download artifacts:
   Go to Releases page → v1.1.0 → Download
```

## 📚 Documentation

- **Quick start** (this file): `RELEASE-QUICK-START.md`
- **Complete guide**: `RELEASE.md`
- **Script details**: `scripts/README.md`
- **Workflow files**: `.github/workflows/snapshot-build.yml` and `release-desktop.yml`

## 🆘 Troubleshooting

### "Build didn't trigger"
1. Check the tag was pushed: `git push origin v1.0.0`
2. Confirm tag exists on GitHub: Go to Releases page
3. Check Actions tab for any errors

### "Old version built instead"
The workflow prevents building older releases if a newer one exists on main.

### "Build failed on one platform"
Check the Actions log for the specific platform. Most failures are:
- Missing signing certificates (macOS/Windows)
- Dependency issues (npm ci might need rerun)
- Outdated node_modules

## 💡 Tips

1. **Test snapshot first**: Try the latest snapshot before creating a release
2. **Use semantic versioning**: major.minor.patch (e.g., 1.2.3)
3. **Keep commits clean**: One feature/fix per commit
4. **Tag on main only**: Don't create releases from side branches
5. **Releases are immutable**: You can't change a release, only create new ones

## ✨ You're All Set!

Your Prime Silo project now has:
- ✅ Automatic snapshot builds for every commit
- ✅ One-command release creation
- ✅ Multi-platform desktop builds
- ✅ GitHub Release page generation
- ✅ Version tracking and management

Push that first release tag and watch the magic happen! 🎉

```bash
git push origin v1.0.0
```
