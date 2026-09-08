// What the estate knows about its own published releases.
//
// Everything here is pure: it takes releases and feed text that somebody else fetched and
// returns a verdict. The network lives in the caller, so the judgement can be tested against
// the exact shapes GitHub actually returned, including the broken one this module was written
// to name.
//
// THREE STATES, NOT TWO. A feed that lists every architecture is `covered`. A feed missing one
// is `gap`. A feed nobody could fetch is `unknown` — never `gap`, because "I could not look"
// and "I looked and it is wrong" lead to different actions and only one of them is an alarm.
//
// A GAP IS NOT AUTOMATICALLY A BREAKAGE — BUT THE EXEMPTION IS ONE PLATFORM WIDE. The desktop
// host carries an arch fallback: when the feed lists no installer for the running architecture
// it downloads the canonical asset directly. That code begins `if (process.platform !== "win32")
// return null`, so it protects Windows and nothing else. A first draft of this module graded
// every published-but-unlisted arch as `mitigated`, which quietly excused a real Linux arm64
// gap by crediting it with a fallback that does not run there. Mitigation is therefore a
// property of the PLATFORM, not of the gap: the same shape of defect is `mitigated` on Windows
// and `stranded` on macOS and Linux, where electron-updater's own `?? filteredFiles.shift()`
// hands the machine an installer for the wrong architecture.
//
// The other direction is always stranded: a feed naming an asset that was never published
// points every matching machine at a file that is not there.
//
// A TAG IS NOT A RELEASE. A v* tag with no release behind it means CI started and never
// finished publishing. That state is invisible on GitHub's releases page — the tag simply is
// not there — which is exactly why the estate has to name it.

/** Minimal reader for the updater feed electron-builder writes. Deliberately not a YAML
 *  parser: the feed has a fixed shape, and a general parser would accept documents this code
 *  has no business trusting. Returns null when the text is not that shape. */
export function parseFeed(text) {
  const src = String(text || "");
  if (!src.trim()) return null;
  const version = (src.match(/^version:\s*(.+)$/m) || [])[1]?.trim() || null;
  if (!version) return null;
  const files = [];
  // Entries look like "  - url: NAME" followed by indented sha512/size lines.
  for (const m of src.matchAll(/^\s*-\s*url:\s*(.+)$/gm)) {
    const url = m[1].trim().replace(/^["']|["']$/g, "");
    if (url) files.push({ url });
  }
  const path = (src.match(/^path:\s*(.+)$/m) || [])[1]?.trim() || null;
  return { version, files, path };
}

const ARCHES = ["x64", "arm64"];

// Platforms whose installed app can rescue itself from a feed that omits its architecture.
// Exactly one, and it is named here rather than assumed, so adding the same fallback to another
// platform is a one-line change beside the reason instead of a re-grading nobody notices.
const HAS_ARCH_FALLBACK = new Set(["windows"]);

/** The architecture an asset name declares, or null. Order matters: "arm64" contains "64". */
export function archOf(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("arm64") || n.includes("aarch64")) return "arm64";
  if (n.includes("x64") || n.includes("x86_64") || n.includes("amd64")) return "x64";
  return null;
}

/** The platform an asset name declares, or null. */
export function platformOf(name) {
  const n = String(name || "").toLowerCase();
  if (/\.exe$|windows|win32/.test(n)) return "windows";
  if (/\.dmg$|\.zip$|macos|darwin|-mac/.test(n)) return "mac";
  if (/\.appimage$|\.deb$|\.rpm$|linux/.test(n)) return "linux";
  return null;
}

const isInstaller = (name) => /\.(exe|dmg|appimage|deb|rpm|zip)$/i.test(String(name || ""));

/**
 * Judge one platform's feed against the assets actually published on the release.
 *
 * @param feed    parsed feed, or null when it could not be read/fetched
 * @param assets  every asset name on the release
 * @param platform "windows" | "mac" | "linux"
 */
export function feedCoverage({ feed, assets = [], platform }) {
  const installers = assets.filter((a) => isInstaller(a) && platformOf(a) === platform);
  const published = new Set(installers.map(archOf).filter(Boolean));

  if (!feed) {
    return {
      platform,
      state: "unknown",
      // Named rather than left as a silent null: a feed nobody could read is a fact about the
      // check, not about the release, and the surface must be able to say which it is.
      reason: "the feed could not be read",
      listed: [],
      published: [...published].sort(),
      gaps: []
    };
  }

  const listed = new Set(feed.files.map((f) => archOf(f.url)).filter(Boolean));
  // An asset published for an arch the feed never mentions is the gap that matters. Whether it
  // is survivable depends entirely on where it happens — see the header.
  const gaps = [...published]
    .filter((a) => !listed.has(a))
    .map((arch) => ({
      arch,
      severity: HAS_ARCH_FALLBACK.has(platform) ? "mitigated" : "stranded",
      mitigation: HAS_ARCH_FALLBACK.has(platform)
        ? "the desktop host downloads the canonical asset for this arch directly"
        : null
    }));
  // An arch the feed lists but has no asset for is the opposite failure and strands anyone
  // whose machine matches it: the updater is pointed at a file that is not there.
  for (const arch of listed)
    if (!published.has(arch))
      gaps.push({
        arch,
        severity: "stranded",
        mitigation: null
      });

  const missingEntirely = ARCHES.filter((a) => !published.has(a) && !listed.has(a));

  return {
    platform,
    state: gaps.length ? "gap" : "covered",
    listed: [...listed].sort(),
    published: [...published].sort(),
    // Not a defect: a platform the release simply does not build for.
    not_built: missingEntirely,
    gaps
  };
}

/** Order two v-tags. Not semver-complete — enough to rank this project's own tags, and
 *  deliberately numeric per segment so v1.10.0 sorts above v1.9.0 rather than below it. */
export function compareTags(a, b) {
  const parts = (t) =>
    String(t)
      .replace(/^v/, "")
      .split(/[.-]/)
      .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const l = x[i] ?? 0;
    const r = y[i] ?? 0;
    if (l === r) continue;
    if (typeof l === "number" && typeof r === "number") return l - r;
    return String(l) < String(r) ? -1 : 1;
  }
  return 0;
}

/**
 * Tags with no release behind them — CI that started and never finished publishing.
 *
 * ONLY JUDGED INSIDE THE WINDOW WE ACTUALLY LOOKED AT. Callers fetch a page of recent releases,
 * so every older tag is absent from that list for a reason that has nothing to do with whether
 * it published. A first version ignored this and reported eighty historical tags as unpublished
 * — a gauge that is wrong eighty times out of eighty-one teaches you to ignore it, which is
 * worse than not having it. So the answer is bounded by the oldest release examined, and
 * `window` says what that bound was rather than leaving the caller to assume completeness.
 */
export function unpublishedTags({ tags = [], releases = [] } = {}) {
  const published = new Set(releases.map((r) => String(r.tag_name || "")));
  const known = [...published].filter((t) => /^v\d/.test(t)).sort(compareTags);
  const floor = known[0] || null;
  return tags
    .map(String)
    .filter((t) => /^v\d/.test(t) && !published.has(t))
    .filter((t) => !floor || compareTags(t, floor) > 0)
    .sort(compareTags);
}

/**
 * The whole verdict, folded once.
 *
 * `feeds` is a map of platform -> parsed feed (or null where it could not be read), so a
 * caller that failed to fetch one feed still gets a complete answer about the rest.
 */
export function releaseHealth({ release = null, feeds = {}, tags = [], releases = [] } = {}) {
  if (!release) {
    return {
      state: "none",
      reason: "no published release was found",
      latest: null,
      coverage: [],
      unpublished: unpublishedTags({ tags, releases })
    };
  }

  const assets = (release.assets || []).map((a) => a.name || a);
  const coverage = ["windows", "mac", "linux"]
    .map((platform) => feedCoverage({ feed: feeds[platform] ?? null, assets, platform }))
    // A platform with no installers at all is not built for; do not report an empty verdict.
    .filter((c) => c.published.length || c.listed.length || c.state === "unknown");

  const stranded = coverage.flatMap((c) => c.gaps.filter((g) => g.severity === "stranded"));
  const mitigated = coverage.flatMap((c) => c.gaps.filter((g) => g.severity === "mitigated"));
  const unknown = coverage.filter((c) => c.state === "unknown");

  return {
    state: stranded.length
      ? "stranded"
      : mitigated.length
        ? "degraded"
        : unknown.length
          ? "partial"
          : "covered",
    latest: {
      tag: release.tag_name || null,
      published_at: release.published_at || null,
      assets: assets.length
    },
    coverage,
    counts: {
      stranded: stranded.length,
      mitigated: mitigated.length,
      unreadable_feeds: unknown.length,
      // The population, always beside the count.
      platforms: coverage.length
    },
    unpublished: unpublishedTags({ tags, releases }),
    // The bound the answer above was judged inside, so a surface can say "of the last N
    // releases" instead of implying it checked the whole history.
    unpublished_window: releases.length
  };
}
