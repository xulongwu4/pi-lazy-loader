# Phase 0 - per-package pi startup cost

Measured 2026-09-03 22:51, host `solus`. Each figure is the **minimum of 3 runs**.

## Commands

```bash
# baseline (extension discovery disabled)
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 pi -ne --list-models
# full startup (all packages from settings.json)
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 pi --list-models
# single package in isolation
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 pi -ne -e <PACKAGE_DIR> --list-models
```

## Controls

| Measurement | min of 3 |
|---|---|
| Baseline `-ne` | **0.565 s** |
| Full startup (33 packages) | **5.833 s** |
| **Extension overhead** | **5.268 s** |

## Per-package cost (ranked)

| # | Package | Runs (s) | Min (s) | Cost (s) | %% of overhead | Cumulative %% |
|---|---|---|---|---|---|---|
| 1 | `npm:pi-fabric` | 1.77, 1.67, 1.82 | 1.667 | **1.102** | 20.9% | 20.9% |
| 2 | `npm:@zosmaai/pi-llm-wiki` | 1.42, 1.32, 1.27 | 1.267 | **0.702** | 13.3% | 34.2% |
| 3 | `npm:@tintinweb/pi-subagents` | 1.17, 1.17, 1.17 | 1.166 | **0.601** | 11.4% | 45.6% |
| 4 | `npm:@quintinshaw/pi-dynamic-workflows` | 1.12, 1.07, 1.07 | 1.066 | **0.501** | 9.5% | 55.1% |
| 5 | `npm:@narumitw/pi-goal` | 1.07, 0.97, 1.12 | 0.966 | **0.401** | 7.6% | 62.7% |
| 6 | `npm:pi-token-burden` | 0.92, 0.87, 0.87 | 0.865 | **0.300** | 5.7% | 68.4% |
| 7 | `npm:pi-antigravity` | 0.87, 0.82, 0.87 | 0.815 | **0.250** | 4.8% | 73.2% |
| 8 | `npm:pi-mcp-adapter` | 0.82, 0.77, 0.82 | 0.765 | **0.200** | 3.8% | 77.0% |
| 9 | `npm:pi-web-access` | 0.82, 0.67, 0.67 | 0.665 | **0.100** | 1.9% | 78.9% |
| 10 | `git:github.com/xulongwu4/pi-quotas` | 0.77, 0.67, 0.72 | 0.665 | **0.100** | 1.9% | 80.8% |
| 11 | `git:github.com/xulongwu4/pi-devin` | 0.67, 0.72, 0.67 | 0.665 | **0.100** | 1.9% | 82.7% |
| 12 | `npm:@juanbenjumea/pi-dynamic-footer` | 0.66, 0.67, 0.67 | 0.665 | **0.100** | 1.9% | 84.6% |
| 13 | `npm:@juicesharp/rpiv-todo` | 0.67, 0.61, 0.67 | 0.615 | **0.050** | 0.9% | 85.5% |
| 14 | `git:github.com/xulongwu4/pi-free-openai-gateways` | 0.62, 0.62, 0.61 | 0.615 | **0.050** | 0.9% | 86.5% |
| 15 | `npm:@a5c-ai/babysitter-pi` | 0.62, 0.62, 0.57 | 0.566 | **0.001** | 0.0% | 86.5% |
| 16 | `npm:context-fold` | 0.67, 0.62, 0.57 | 0.565 | **0.000** | 0.0% | 86.5% |
| 17 | `npm:pi-messenger` | 0.56, 0.56, 0.56 | 0.565 | **0.000** | 0.0% | 86.5% |
| 18 | `npm:pi-gitnexus` | 0.61, 0.56, 0.61 | 0.565 | **0.000** | 0.0% | 86.5% |
| 19 | `npm:@amb007/deep-wiki` | 0.62, 0.56, 0.62 | 0.565 | **0.000** | 0.0% | 86.5% |
| 20 | `npm:@gotgenes/pi-anthropic-auth` | 0.56, 0.56, 0.56 | 0.565 | **0.000** | 0.0% | 86.5% |
| 21 | `npm:pi-btw` | 0.62, 0.57, 0.51 | 0.515 | **0.000** | 0.0% | 86.5% |
| 22 | `npm:pi-autoresearch` | 0.52, 0.56, 0.57 | 0.515 | **0.000** | 0.0% | 86.5% |
| 23 | `npm:@hicaru/pi-rlm` | 0.61, 0.57, 0.62 | 0.565 | **0.000** | 0.0% | 86.5% |
| 24 | `npm:@dietrichgebert/ponytail` | 0.51, 0.51, 0.51 | 0.515 | **0.000** | 0.0% | 86.5% |
| 25 | `npm:@mrclrchtr/supi-context` | 0.61, 0.61, 0.56 | 0.565 | **0.000** | 0.0% | 86.5% |
| 26 | `npm:@mrclrchtr/supi-insights` | 0.61, 0.61, 0.56 | 0.565 | **0.000** | 0.0% | 86.5% |
| 27 | `npm:@tmustier/pi-usage-extension` | 0.56, 0.56, 0.56 | 0.565 | **0.000** | 0.0% | 86.5% |
| 28 | `npm:pi-context-view` | 0.56, 0.56, 0.61 | 0.565 | **0.000** | 0.0% | 86.5% |
| 29 | `npm:pi-context-usage` | 0.56, 0.61, 0.56 | 0.565 | **0.000** | 0.0% | 86.5% |
| 30 | `https://github.com/cathrynlavery/diagram-design` | 0.51, 0.51, 0.51 | 0.515 | **0.000** | 0.0% | 86.5% |
| 31 | `git:github.com/xulongwu4/pi-cline-pass` | 0.51, 0.51, 0.56 | 0.515 | **0.000** | 0.0% | 86.5% |
| 32 | `npm:pi-memory` | 0.51, 0.56, 0.51 | 0.515 | **0.000** | 0.0% | 86.5% |
| 33 | `npm:@juicesharp/rpiv-ask-user-question` | 0.56, 0.62, 0.62 | 0.565 | **0.000** | 0.0% | 86.5% |
| 34 | `npm:pi-hashline-edit-pro` | 0.62, 0.57, 0.61 | 0.565 | **0.000** | 0.0% | 86.5% |
| 35 | `npm:pi-cache-optimizer` | 0.57, 0.67, 0.62 | 0.565 | **0.000** | 0.0% | 86.5% |
| 36 | `npm:pi-intercom` | 0.57, 0.57, 0.57 | 0.565 | **0.000** | 0.0% | 86.5% |

## Smallest deferral set reaching >= 80%% of overhead

**10 of 36 packages** cover 4.257 s of the 5.268 s overhead (80.8%):

- `npm:pi-fabric` - 1.102 s
- `npm:@zosmaai/pi-llm-wiki` - 0.702 s
- `npm:@tintinweb/pi-subagents` - 0.601 s
- `npm:@quintinshaw/pi-dynamic-workflows` - 0.501 s
- `npm:@narumitw/pi-goal` - 0.401 s
- `npm:pi-token-burden` - 0.300 s
- `npm:pi-antigravity` - 0.250 s
- `npm:pi-mcp-adapter` - 0.200 s
- `npm:pi-web-access` - 0.100 s
- `git:github.com/xulongwu4/pi-quotas` - 0.100 s

Deferring these would take startup from **5.83 s to about 1.58 s**.

## Anomalies

- Sum of individual costs = **4.557 s** vs measured aggregate overhead **5.268 s** (ratio 0.86x). Individual measurements over-count because each package pays full price for shared module graphs (typebox, pi-tui, undici, zod) that are loaded only once when all packages load together. Treat per-package costs as an upper bound and the ranking as the reliable signal.

## Verification (independent, post-hoc)

**1. Is `-e <dir>` really loading each package?** Yes. Packages that register CLI flags show them only when passed via `-e`:

| Check | Result |
|---|---|
| `pi -ne -e .../pi-gitnexus --help` contains `--gitnexus-cmd` | yes |
| `pi -ne -e .../@hicaru/pi-rlm --help` contains `--rlm` | yes |
| `pi -ne -e .../pi-mcp-adapter --help` contains `--mcp-config` | yes |
| control: `pi -ne --help` contains any of them | **no** |

So packages measuring 0.000 s genuinely load below the ~50 ms noise floor.

**2. Is any of the overhead skills/prompts/themes rather than extensions?** No.

| Config | min of 3 |
|---|---|
| full (everything) | 5.56 s |
| `-ns` (no skills) | 5.86 s |
| `-ne` (no extensions) | 0.50 s |
| `-ne -ns` | 0.49 s |
| `-ne -ns -np --no-themes -nc` | 0.48 s |

Disabling skills changes nothing; disabling extensions recovers everything. **100% of the overhead is extension loading**, which is what a lazy extension loader can address. This also confirms the advisor's design point: keeping skills eager costs nothing.

**Correction to the anomaly note above.** Sum-of-individuals (4.56 s) is *lower* than aggregate overhead (5.07-5.27 s), the opposite of the predicted over-count. Cause: ~26 packages cost less than the measurement noise floor and were clamped to 0.000, so their real 20-40 ms each is discarded — roughly the missing 0.5-0.7 s. Per-package figures for the top ranks remain sound; the tail is simply "too small to measure", which is itself the answer.

**Package count:** settings contains **36** packages, not 33 as stated in the brief.
