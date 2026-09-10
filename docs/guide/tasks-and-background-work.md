# Tasks and background work

One Code keeps long-running work out of the model's way. This page covers
the structured task list, background shells, monitors, scheduled
wake-ups, and how the results of background work reach the model.

## The task list

For multi-step work the model keeps a structured task list, using the
`task_create`, `task_get`, `task_list`, and `task_update` tools. Each task
has a subject, a description, a status (pending, in progress, or
completed), an optional owner, and dependencies on other tasks.

While the list has entries, a pinned widget below the transcript shows a
summary line and up to 12 tasks: `✔` for completed, `◼` for in progress,
`◻` for pending.

| Command | What it does |
|---|---|
| `/tasks` | Prints the full list. |
| `/tasks hide` | Hides the widget. |
| `/tasks show` | Shows it again. |

The list is stored inside the session, so it survives a resume and follows
the branch you are on in `/tree`. If the model has not touched the list for
a while during a long task, it is reminded that the list exists.

## Background shells

When the model runs a command with `run_in_background`, the command starts
detached and the model gets a task id at once. Output spools to a log file
under the session directory. When the command finishes, the model is
notified with the result, and it can read the output at any time with
`task_output` or stop the command with `task_stop`.

Running and recently finished shells appear in the panel below the editor:

1. Press **↓** from an empty editor to focus the shells chip.
2. Press **Enter** to open the Background list, which shows each shell's
   status and command. **↑** and **↓** select, **x** stops the selected
   shell, **Esc** goes back.
3. Press **Enter** on a shell to see its status, runtime, command, and a
   live box with the last lines of output. **←** returns to the list;
   **Esc**, **Enter**, or **Space** closes the section; **x** stops it.

A finished shell stays in the list for a minute. From the chip, a second
**↓** moves on to the subagent rows in the same panel.

The turn-duration line reports how many shells are still running when a
turn ends. When a session ends, running shells are stopped and the next
session is told which ones.

## Monitors

The `monitor` tool watches a long-running command, or a WebSocket URL, and
turns each line of output (or each message) into an event. Events are
batched and delivered to the model as notifications: at most once a second
while the model is idle, once every ten seconds while it is working, so a
noisy process does not flood the conversation.

A monitor runs until its command exits or its timeout passes (five minutes
by default, one hour at most), or for the whole session when started as
persistent. The model can stop it with `task_stop`.

A monitor is not auto-approved, because it runs a shell command; the
permission gate treats it like `bash`.

## Scheduled wake-ups and loops

`/loop` runs a task repeatedly. Two forms exist:

- **Fixed interval.** `/loop 5m check whether the deploy finished` runs the
  task every five minutes. Intervals accept `s`, `m`, and `h`, and are
  clamped between one minute and one hour. The first run happens
  immediately. A tick that arrives while the model is still busy is
  skipped, not queued.
- **Self-paced.** `/loop watch the CI run` with no interval lets the model
  choose when to check next. It uses the `schedule_wakeup` tool, which
  schedules one wake-up at a time between one minute and one hour ahead.
  The model is told to pick a delay that matches what it is waiting for,
  and to stop the loop when the task is done.

`/loop status` (or a bare `/loop`) reports the current loop. `/loop stop`
ends it. Only one loop runs at a time, and loops end with the session.

## The background list

`/background` lists every background task in the session: monitors,
background shells, and background subagents, with their id, kind, status,
and start time. A small widget shows the count of running tasks that have
no panel of their own.

## How results reach the model

Background work reports back through notifications:

- A notification is delivered as soon as the model finishes its current
  batch of tool calls, or starts a new turn if the model is idle.
- Notifications that arrive within a quarter of a second of each other are
  merged into one message.
- After you interrupt a turn, notifications are held and attached to your
  next prompt instead of starting a turn on their own.
- Each notification is framed as an automated event, so the model does not
  mistake it for something you said or approved.

## Non-interactive runs

In `-p` and `--mode json` runs nothing can run in the background, because
the process exits when the turn settles. Background shells, monitors,
subagents, and workflows run to completion and return their output
directly. `/loop` and `schedule_wakeup` do not fire.
