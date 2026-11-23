# 009 Harness Upgrades (P0 / P1 / P2)

Summary of the harness engineering, MCP protocol, security, observability, and engine pipeline upgrades implemented across the repository.

## P0 — MCP Server Architecture & Security Boundaries

- **Modular Domain Registrars (`src/mcp/context.ts`, `src/mcp/tools/*.ts`)**: Split the 53-tool monolith into six domain modules (`pipeline`, `unreal`, `godot`, `assets`, `character`, `studio`).
- **Scoped & Dynamic Toolsets (`HARNESS_TOOLSETS`, `HARNESS_DYNAMIC_TOOLSETS=1`)**: Enables progressive tool discovery via `harness_toolsets` and `notifications/tools/list_changed`, cutting initial tool-definition context from **~11,107 tokens (53 tools)** to **~2,904 tokens (14 tools)** — a **74% reduction**.
- **MCP Tool Annotations, Progress & Elicitation**: Every tool now declares `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`. Long-running tools (`studio_check`, `studio_export`, `studio_simulate_battle`, `studio_install_godot`, `character_build`, `character_install`, `character_generate_references`) emit `notifications/progress`, and `studio_export` uses native MCP elicitation (`elicitation/create`) when supported by the client.
- **Streamable HTTP Transport (`src/mcp/main.ts`)**: Pass `--http <port>` or `HARNESS_MCP_HTTP_PORT=<port>` to expose `/mcp` over Streamable HTTP alongside stdio.
- **Enforced Sandbox Policy & Watchdog (`src/executors/sandbox.ts`, `src/executors/agent-cli.ts`)**: Generates deterministic PreToolUse hooks (`.claude/settings.local.json`, `harness-pretool-hook.mjs`) enforcing `preset.blockedCommands`, adds `checkCommandPolicy` + `isWithinAllowedRoots`, and adds a stall watchdog (`stallTimeoutMs`) to abort silent/hung workers early.
- **Unreal Undo Transactions (`src/mcp/tools/unreal.ts`)**: `unreal_python` supports `transaction: true` to wrap editor mutations in `unreal.ScopedEditorTransaction`.
- **SQLite Lock Backend (`src/locks/index.ts`)**: `SqliteLockBackend` (Node 22+ `node:sqlite`, WAL mode + 5s `busy_timeout`, enabled via `HARNESS_LOCK_BACKEND=sqlite`) eliminates stale-mutex races.

## P1 — Telemetry, Cost Budgets, Evals & Engine Modernization

- **SQLite Run Store (`src/core/store.ts`)**: `SqliteRunStore` persists run snapshots and an unlimited append-only `events` table (`queryEvents`).
- **OpenTelemetry Spans & Plan Budgets (`src/core/telemetry.ts`, `src/core/orchestrator.ts`)**: `TraceCollector` emits OTel-compatible JSONL spans (`traces.jsonl`) with optional `OTEL_EXPORTER_OTLP_ENDPOINT` export. `BudgetTracker` enforces `Plan.budget` (`maxTokens`, `maxCostUsd`, `maxWallMinutes`).
- **Incremental Re-Planning (`Orchestrator.replan`)**: Content-hashes ticket specs and dependencies so unchanged tickets keep delivered assets while only changed tickets and downstream consumers re-run.
- **Automated Eval Suite (`scripts/eval-harness.ts`, `npm run eval`)**: Measures first-try contract pass rate, revisions, violations caught, and span counts in CI.
- **Unreal Interchange Framework (`dcc/unreal/import_pipeline.py`)**: Uses UE 5.5–5.8 `InterchangeManager` / `InterchangeGenericAssetsPipeline` (supporting FBX + glTF/GLB) with automatic fallback to `FbxImportUI` on UE ≤ 5.4.
- **ITU-R BS.1770-4 LUFS & True Peak (`src/contracts/wav.ts`, `src/contracts/index.ts`)**: Measures K-weighted integrated loudness (`lufs`) and 4x cubic-interpolated true peak (`truePeakDb`), enforcing optional `lufsDb` and `maxTruePeakDb` audio specs.
- **Configurable Godot Version (`src/godot/install.ts`)**: Supports `HARNESS_GODOT_VERSION` (with `RECOMMENDED_GODOT_VERSIONS = ['4.6', '4.5.1', '4.4.1']`).

## P2 — Generative Pipeline & 3D Studio Starter

- **ComfyUI Adapter (`src/character/imagegen.ts`)**: Added `comfyui` provider (`/prompt`, `/history`, `/view`) for local Flux/SDXL turnaround generation.
- **Standardized Asset Provenance (`src/assets/provenance.ts`)**: Uniform `.provenance.json` sidecars with SHA-256 checksums, prompt hashes, model/tool, license, and timestamp.
- **Advisory VLM Visual QA (`src/studio/vlm.ts`)**: Optional OpenAI/Gemini vision critique helper (`reviewVisualAsset`) for checking preview renders before human review.
- **3D Godot Starter Template (`templates/godot-3d-starter/`)**: Added `godot-3d-starter` to `studio_new_project` / `TEMPLATES` for 3D games powered by `character_build` and `character_install`.

