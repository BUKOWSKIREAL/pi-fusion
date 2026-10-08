# Pi Fusion

Pi Fusion is a [Pi](https://pi.dev) extension that adds a persistent **lead / sidekick** workflow. Your current Pi model stays the **lead**. It makes the decisions, writes briefs, reviews results and talks to you. A second model you have already configured runs as a **sidekick**: one long-lived worker that does bounded implementation and verification work in the same workspace.

The sidekick keeps its own conversation from one handoff to the next. So the lead can send follow-up work without explaining everything again, and it can still review every change before reporting back.

Optional **Jev routing advice** can suggest whether a new request should go to the lead or the sidekick. It is advice only. It never changes the main model and never starts a handoff by itself.

This is an independent extension. It is not affiliated with Cognition or Devin. See [License and provenance](#license-and-provenance).

## Requirements

- Node.js `>=22.19.0`
- Pi (tested with Pi 1.0.3)
- A sidekick provider and model that is already set up in Pi, with working credentials

## Quick start

```bash
pi install npm:pi-local-fusion
```

To install from GitHub instead:

```bash
pi install git:github.com/BUKOWSKIREAL/pi-fusion
```

For a local checkout, use `pi install ./pi-fusion` instead.

Then, in Pi:

```text
/reload
/fusion
```

The first time, `/fusion` goes straight to the model picker: choose one of the models Pi already has credentials for and Fusion turns on. The choice is saved as your default, so later Pi launches start with that sidekick. The lead model does not change, and Pi's own `/model` still controls it.

After that, `/fusion` opens a short settings view — the current sidekick, an on/off toggle, and details. `/fusion-model` is a shortcut that opens the same picker again. Virtual model routers are not offered, because the sidekick needs one real model.

Send tasks in plain language and the lead decides what to delegate:

```text
Add CSV export to the reports page. Settle the design first, then hand the
implementation and focused tests to the sidekick. Review the full diff and
test output before reporting back.
```

Optional: to set the sidekick model by hand instead of picking it, use the exact identifier from Pi's `/model` list:

```text
/fusion model provider/model-id
```

## How it works

| Role | Responsibilities |
| --- | --- |
| Lead | Talks to you, plans, makes decisions, writes handoff briefs, reviews the diff and evidence |
| Sidekick | Does bounded implementation, search and verification, then reports back with evidence |

- **One sidekick per lead session.** If the lead calls `sidekick` again while work is running, the new message goes to the same worker as a steering update. A second sidekick is never created. Updates are applied at the next tool boundary and do not interrupt a file operation already in progress.
- **Blocking vs background.** `sidekick({message, block: true})` waits up to 60 seconds. If that wait runs out, only the wait has timed out. The work keeps running in the background, and the lead is notified when it finishes. `block: false` returns right away so the lead can do other work. `read_sidekick` can wait up to 300 seconds for a report. `stop_sidekick` cancels the current run.
- **Separate context.** The sidekick sees only the handoffs, its own history and workspace instructions that Pi discovers (such as `AGENTS` files). It does not get the lead's conversation, and it cannot see your messages unless the lead passes them on.
- **Shared files.** Both models work in the same directory, so the lead should avoid editing the same code the sidekick is working on. Moving through conversation history does not undo file changes.
- **Usage counted once.** Sidekick token and cost usage is added to the lead session when the lead receives a blocking result or calls `read_sidekick`. A background completion notice carries no usage. Until the lead reads the report, `/cost` leaves that sidekick usage out. Reading the same report again does not count it twice.
- **Limited child runtime.** The sidekick loads only Pi's built-in tools. In `coding` mode that is read, grep, find, ls, edit, write and bash; in `readonly` mode it is read, grep, find and ls. It does not load the lead's extensions, MCP servers, skills or custom tools. Each bash call is a separate shell, so there is no persistent shell session. The sidekick runs with your OS permissions, and bash is not sandboxed.

Pressing Esc during a blocking wait cancels the sidekick's current run. Exiting, reloading, switching sessions or navigating the session tree also stops the current run. The sidekick's context is kept in each case.

Sidekick transcripts are saved under `~/.pi/agent/fusion/sessions/`. `/fusion status` shows the current file, which you can open with `pi --session <file>`.

## Commands

### Daily use

| Command | Effect |
| --- | --- |
| `/fusion` | Open settings. The first time it opens the model picker; afterwards it shows the sidekick, an on/off toggle and details. |
| `/fusion-model` | Open the model picker to choose or change the sidekick. |
| `/fusion off` | Stop current work and turn Fusion off. The setting is remembered for later launches. |
| `/fusion status` | Show details: limits, defaults file, sidekick session file and last handoff usage. |

`/fusion on` needs a sidekick model first; without one it opens the picker. Turning Fusion on or off from the settings view needs no model identifier.

### Advanced commands

| Command | Effect |
| --- | --- |
| `/fusion model provider/model-id` | Set the default sidekick model by hand and turn Fusion on |
| `/fusion assign provider/model-id` | Use a physical sidekick model on this session branch; keep the current child context and global defaults |
| `/fusion compact` | Compact an idle sidekick, retaining delivered handoff text verbatim; summary requests are billed |
| `/fusion on` / `/fusion off` | Enable / stop current work and disable |
| `/fusion thinking <level>` | `off`, `minimal`, `low`, `medium` (default), `high`, `xhigh`, `max`. The SDK limits this to what the model supports |
| `/fusion tools coding` / `readonly` | Sidekick tool set; default `coding` |
| `/fusion timeout <minutes>` | Total time limit per handoff, 1–240; default 15 |
| `/fusion turns <count>` | Turn limit per handoff, 1–1000; default 80 |
| `/fusion reminders on` / `off` | One-time reminders on the first message and the lead's first direct edit; default on |
| `/fusion routing jev` / `off` | Jev routing advice; default off |
| `/fusion stop` | Cancel the current sidekick run; keeps its context and file changes |
| `/fusion reset` | Stop the sidekick and drop its saved context pointer (see below) |
| `/fusion help` | List every command |

Stop active work with `/fusion stop` before changing the sidekick model or worker settings.

Model changes preserve the idle child session. Assignment changes do not change its role or tools. Compaction uses Pi's scheduling and a local handoff-preservation adapter; it does not implement Devin's asynchronous spawn/apply/hard scheduler. When the preserved text and remaining context cannot fit the estimated model budget, compaction stops with an error instead of dropping handoff text. Failed and cancelled summary attempts with reported usage are included in Fusion usage.

## Global defaults and session state

Settings are saved globally in:

```text
~/.pi/agent/fusion/config.json
```

If `PI_CODING_AGENT_DIR` is set, this file (and the sidekick sessions directory) lives under that directory instead. `/fusion status` shows the path actually in use.

- The file stores only the on/off state plus `model`, `thinking`, `tools`, `timeout`, `turns`, `reminders` and `routing`. Each successful command for one of these updates it. `stop`, `reset`, `status`, reload and exit leave it alone.
- New sessions start with these defaults. A session branch that already has saved Fusion state keeps its own state, which takes priority over the defaults.
- On reload, an older session that already had a sidekick model is copied into the defaults once, but only if no defaults file exists yet. An existing file is never overwritten this way.
- If the file can't be read or is invalid, Pi shows a warning and the session falls back to the built-in defaults.
- `PI_FUSION_MODEL` only pre-fills the sidekick model when none is set. It never turns Fusion on by itself.
- The `/fusion assign` model override, sidekick history, last-handoff results, Jev advice and usage totals stay with each session branch. None are written to the defaults file. Credentials remain in Pi's provider configuration or the environment; Fusion does not store them.

## Optional Jev routing advice

```text
/fusion routing jev
```

- Off by default. Turning it on requires `TYPESAFE_API_KEY` in the environment; that is the only place the key is read from.
- For each new user request, one TypeSafe Choice call sends only that request (up to 8000 characters) and a fixed description of the two roles. It does not attach code files, the whole conversation or credentials; anything included in the current request itself is sent.
- The classifier answers `lead`, `sidekick` or `uncertain`. It recommends the sidekick only when the choice is `sidekick` **and** confidence is at least 0.8 **and** the sidekick probability is at least 0.85. Every other result, including errors, missing keys and over-long input, falls back to the lead.
- Each call has a 4-second timeout and is never retried.
- The advice is passed to the lead as guidance. The lead still decides whether to hand off, writes the brief and reviews the result. The thresholds are conservative rules of thumb, not calibrated accuracy figures.
- Jev token usage appears separately in `/fusion status`. It is not part of `/cost`.

[evaluation/jev-routing.json](evaluation/jev-routing.json) contains a 10-case synthetic smoke test of the integration. It is not evidence of real-world routing quality or cost savings.

## Status display and troubleshooting

When Fusion is on, Pi's status line shows `Fusion · <state>`, for example `ready`, a progress message, `completed`, `failed` or `cancelled`. In the TUI, a widget below the editor shows the lead and sidekick models side by side and highlights whichever one is generating output.

**`Fusion · failed`** means the most recent handoff failed. Common causes are hitting the turn limit or a provider error. It does not mean the extension or your configuration is broken. This status persists after the report is read and after `/reload`, and it updates with the next handoff. Ask the lead to call `read_sidekick`, or open the sidekick session file, to see what happened.

- `/fusion status` shows the current limits, sidekick session file, defaults path and last handoff usage.
- `/fusion stop` cancels a running handoff. The sidekick's context is kept for the next brief.
- `/fusion reset` stops the sidekick and drops its saved context pointer, so the next handoff starts with a fresh sidekick conversation. Workspace files and global defaults are kept, and the old session file stays on disk for inspection. **It is not a harmless cleanup step.** Use it only when you deliberately want the sidekick to lose its current context, or when an error message tells you to (for example, after the workspace has changed).

If a `/fusion` command or a `sidekick` tool from another extension is also loaded, disable one of them.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm test
```

The tests run against the real Pi SDK with a scripted offline provider and never call paid models. `npx tsx scripts/evaluate-router.ts` is different: it sends real requests to TypeSafe and regenerates `evaluation/jev-routing.json`. The regular tests do not do this.

```text
src/
  index.ts         extension entry: commands, tools, hooks, status
  controller.ts    one active job, steering, waits, cancellation, usage
  sidekick.ts      child AgentSession, checkpoints, tool set
  state.ts         session state and defaults
  preferences.ts   global config.json read/write
  router.ts        optional Jev advice
  prompts.ts       prompt assembly and Pi adaptations
  display.ts       dual-model status widget
test/              offline SDK, controller, preference and router tests
scripts/           evaluate-router.ts, extract-prompts.py
evaluation/        jev-routing.json smoke-test output
resources/devin-original/   third-party prompt text (see below)
```

See [DESIGN.md](DESIGN.md) for architecture, checkpointing, usage accounting and validation scope.

## License and provenance

Pi Fusion is an independent extension. It is not affiliated with, endorsed by or published by Cognition or Devin.

The [MIT License](LICENSE) covers only the independently written extension code. It does **not** cover `resources/devin-original/`, or the original prompt text from those files that the extension reproduces at runtime. That material keeps its third-party status, and this repository does not claim any license or redistribution rights for it. Details are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [DESIGN.md](DESIGN.md).
