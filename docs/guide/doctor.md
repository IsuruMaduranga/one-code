# Check your setup with doctor

`/doctor` is One Code's health check, modelled on Claude Code's. It measures
your setup, reports what a session will use, and can have the model repair
the findings.

## The three forms

| Command | What it does |
|---|---|
| `/doctor` | The checkup. One Code builds the report and hands it to the model, which reviews the findings and proposes or applies fixes. With no model available, it falls back to showing the report. |
| `/doctor report` | The report alone, in a scrollable panel, with no model call. Includes a network check for a newer version. |
| `onecode doctor` | The report from the shell, without starting a session. Bundled app only. |

`/doctor presets` and `/doctor preset <name>` are described in
[Model presets](#model-presets).

## What the report contains

1. **Installation.** Whether you run the bundled app or the extension on
   your own pi, the pi version and whether it is in the tested range, the
   Node version and platform, pi's agent directory, One Code's state
   directory, where Claude Code configuration is read from, and whether a
   newer One Code is available.
2. **Providers.** Each provider with credentials, how many models it
   offers, and where the credential came from. An error when none is
   ready, with the free options named.
3. **Models.** The main model with its price and context window, the
   prompt tier it gets, the reasoning effort, the subagent model and how it
   was chosen, the auto-mode classifier model, the reader model used by
   web fetch and recaps, capability verdicts for each role when an
   Artificial Analysis key is set, and the permission mode.
4. **Presets.** The three model presets for your provider and the model
   each role would get under each.
5. **Imported configuration.** Every settings file found, with the keys One
   Code uses, ignores, and refuses; the instruction files in context with
   their sizes; the memory folder; agents, skills, and commands by origin;
   plugins; and hooks.
6. **MCP servers.** Each configured server, its source, and its connection
   status.
7. **Dependencies.** `git` (required), `rg` (optional), the language
   servers for the languages detected in the project, the commands MCP
   servers need, and the route web search would take. Missing programs
   come with install hints.

Findings are listed first, errors before warnings, each with a suggested
fix. The report is "ready" when at least one provider works, a model is
selected, and there are no errors.

In the panel, press **f** to run the checkup on the report you are reading.

## Model presets

A preset sets the main model, the subagent model, and the classifier model
together, from the provider you are connected to. Only current-generation,
priced models that support tool calls are considered.

| Preset | Main model | Subagents | Classifier |
|---|---|---|---|
| `economical` | The cheapest small model. | Inherit the main model. | Automatic. |
| `balanced` | The cheapest Sonnet-class model. | Chosen automatically (a cheaper model when one qualifies). | Automatic. |
| `quality` | The most capable model available. | Inherit the main model. | Automatic. |

`/doctor presets` shows what each preset would pick. `/doctor preset balanced`
applies one; the aliases `economy`, `cheap`, `balance`, `max`, `maximum`,
and `best` also work. Applying a preset writes the subagent and classifier
choices to `~/.onecode/settings.json` and remembers the main model as pi's
default. Undo any part with `/model`, `/subagent clear`, or
`/auto-mode model clear`.

## The command-line form

```bash
onecode doctor
```

This prints the same report as text. It exits with:

| Code | Meaning |
|---|---|
| 0 | No errors. |
| 1 | At least one error-level finding, such as no provider ready. |
| 2 | The doctor itself failed to run. |

Because it registers the extension package in the isolated agent directory
before reporting, the result matches what a real session would see.
