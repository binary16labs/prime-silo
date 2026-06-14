# Technical Debt Log

Running log of known debt, sharp edges, and deferred fixes. Newest entries at
the top. Each item has an ID (`TD-n`), a status, the impact, and the intended
resolution so an agent or a human can pick it up without re-deriving context.

Status: `open` · `mitigated` (worked around, root cause remains) · `resolved`.

| ID | Status | Title |
|----|--------|-------|
| TD-1 | mitigated | Legacy `dangpy`/Kortex Docker containers clash on host port 3000 |

---

## TD-1 — Legacy `dangpy`/Kortex Docker containers squat on port 3000

**Status:** mitigated (preflight diagnosis added; root cause is environmental) · logged 2026-06-13

**Symptom.** `.\scripts\dev.ps1` appears to start but `http://localhost:3000`
serves an unfamiliar login UI and 404s every prime-silo route
(`/mod/_prime_silo/...`, `/api/integration_audit`). The space-agent shell never
actually binds 3000.

**Root cause.** A leftover Docker container from old Benny work — `dangpy-frontend`
(image `dangpy-frontend`) — publishes `0.0.0.0:3000->80/tcp`. On this machine
Docker runs under WSL2, so the listener on the Windows host shows up as
`wslrelay.exe` owning port 3000, which obscures the real owner. The container's
restart policy is `unless-stopped`, so it silently comes back after a reboot.
Related legacy stacks seen in the same daemon: `dangpy-backend`,
`dangpy-grafana` (:3002), and `benny-*` / `optimus-*` / `dify-*` containers
(none of which clash with prime-silo's core ports today).

**Port map (intended).** shell `:3000` · Benny runtime `:8005` · Memo-Ray server
`:3001` · Memo-Ray client `:5175` (moved from 5173 in commit 99c317d) · Lemonade
`:13305`.

**Mitigation in place.** `scripts/dev.ps1` now runs a **preflight port check**:
it hard-fails with a clear diagnosis (owning PID/name, the
`docker ps --filter publish=3000` / `docker stop` hint, and a pointer here) when
`:3000` is occupied, and soft-warns when `:8005` / `:3001` / `:5175` are already
bound. So the next clash is self-explaining instead of a silent bind failure.

**Operator fix.** Free the port, then relaunch:
```powershell
docker ps --filter publish=3000          # identify the squatter
docker stop dangpy-frontend              # reversible: docker start dangpy-frontend
.\scripts\dev.ps1
```

**Proper resolution (deferred).**
- Decommission the legacy `dangpy`/Kortex stack, or set its containers to
  `--restart=no` (`docker update --restart=no dangpy-frontend ...`) so they stop
  resurrecting on boot. Ideally `docker compose down` the legacy project and
  remove it once nothing depends on it.
- Optional hardening: make the prime-silo shell port a first-class
  `commands/params.yaml` knob surfaced in the wizard, so moving off 3000 is a
  one-liner rather than an env override. (`PORT` already works as an override.)
