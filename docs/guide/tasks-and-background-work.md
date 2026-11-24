# Tasks and background work

[← One Code user guide](README.md)

One Code keeps long-running work out of the model's way. This page covers
the structured task list, background shells, monitors, scheduled
wake-ups, and how the results of background work reach the model.

## The task list

The structured task list is off by default, for every model. Models that
had one kept lists for ordinary work they'd have done fine without, so One
Code leaves out the `task_create`, `task_get`, `task_list`, and
`task_update` tools and the prompt line that points at them. Set
`ONECODE_ENABLE_TODO_TOOLS=1` to turn them on for any model. The prompt then
tells the model to keep a list only for long work with many separate steps,
or when you hand it a list of requests. Each task has a subject, a description, a status (pending, in progress, or
completed), an optional owner, and dependencies on other tasks.

While the list has entries, a pinned widget below the transcript shows a
summary line and up to 12 tasks: `✔` for completed, `◼` for in progress,
`◻` for pending. Once every task is completed, the list clears itself about
five seconds later and the widget goes away. A new task starts a fresh list,
and its numbering carries on from the old one.

| Key | What it does |
|---|---|
| **alt+t** (**ctrl+\\** on macOS) | Hides the widget down to one line, or shows it again. |

`/tasks` isn't about this list. As in Claude Code, it opens the background
tasks: see [Talk to an agent](subagents-and-workflows.md#talk-to-an-agent).

The list is stored inside the session, so it survives a resume and follows
the branch you're on in `/tree`. A list that was already finished comes back
empty. Without the task tools, a list restored from an older session stays
hidden, since nothing could update it. If the model hasn't touched a list for
a while during a long task, it's reminded that the list exists.

## Background shells

When the model runs a command with `run_in_background`, the command starts
detached and the model gets a task id at once. A background command has no
time limit: it runs until it exits or is stopped, even if the model passed a
`timeout`, so a dev server started this way keeps running. (In a `-p` or
`--mode json` run, the command runs in the foreground instead and stops at
its timeout; see [Non-interactive runs](#non-interactive-runs).) Output spools to a log file
under the session directory. When the command finishes, the model is
notified with the result. While it runs, the model can read the log file
with `read` or stop the command with `task_stop`. There's no separate tool
for fetching a task's output: the notification brings the result.

You can also send a command that's already running to the background. Once
a foreground command has run for two seconds, a hint appears under it:
press **ctrl+b** and the command keeps running as a background shell while
the model gets its turn back. The model is told you backgrounded it and where
the output goes, and it's notified when the command exits, the same as for
`run_in_background`. Inside tmux, press **ctrl+b** twice, because tmux takes
the first press as its own prefix. When no command is running, **ctrl+b**
still moves the cursor left in the editor.

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

Background work belongs to the session. Before `/clear`, `/new`,
`/resume`, or a fork stops anything, One Code lists what's running and asks
first. **Cancel** is the default (Esc does the same), so you can let the work
finish or stop it from `/tasks` before switching. Quitting and `/reload`
can't be paused: they stop running work without asking, as Claude Code
does, and `/tasks` says so while anything is running. A process
that a finished shell left behind, such as a dev server started with `&`,
keeps running until you quit.

## Monitors

The `monitor` tool watches a long-running command, or a WebSocket URL, and
turns each line of output (or each message) into an event. Events are
batched and delivered to the model as notifications: at most once a second
while the model is idle, once every ten seconds while it's working, so a
noisy process doesn't flood the conversation.

A monitor runs until its command exits or its timeout passes (five minutes
by default, 30 minutes at most). When the timeout passes, the model gets one
notice with the number of events it delivered, and it starts the monitor
again if it still needs the watch. The model can stop a monitor early with
`task_stop`. The whole stream is also written to a log file under the
session directory, like a background shell's, and a batch too long to show
whole names that file.

A monitor isn't auto-approved, because it runs a shell command; the
permission gate treats it like `bash`.

## Scheduled wake-ups and loops

The model can schedule prompts for itself within a session. Ask it to
"check CI every 10 minutes" or "remind me at 2:30pm to look at the deploy",
and it calls `cron_create` with a five-field cron expression in your local
time. A recurring job fires on every match. A one-shot job fires once and
deletes itself. `cron_list` shows the session's jobs, and `cron_delete`
cancels one. A session holds up to 50 jobs.

A scheduled prompt fires only while the model is idle. A job that comes due
during a turn waits for the turn to end, then fires once, however many
times it matched in the meantime. Like Claude Code, the scheduler spreads
jobs out with a fixed per-job delay: a recurring job fires up to half its
period late (at most 30 minutes), and a one-shot set for :00 or :30 fires
up to 90 seconds early. A prompt that's a slash command, such as
`/babysit-prs`, runs that skill when it fires. When it fires, the transcript shows a dim
`Running scheduled task` line and the model gets the prompt as its next
input. Recurring jobs expire after seven days: they fire one last time and
are deleted. Nothing is written to disk, so jobs end with the session;
`/clear` asks before cancelling them, then tells you which ones it cancelled.

`/loop` runs a task repeatedly. It's Claude Code's `/loop` skill: One Code
hands your input to the model, and the model sets up the loop itself.

- **Fixed interval.** `/loop 5m check whether the deploy finished`, or
  `/loop check the deploy every 20m`, makes the model convert the interval
  to a cron expression, create a recurring job with `cron_create`, confirm
  it with the job id, and run the task right away. An interval that
  doesn't divide its unit evenly is rounded, and the model says what it
  rounded to.
- **Self-paced.** `/loop watch the CI run` with no interval lets the model
  choose when to check next. It runs the task, then calls
  `schedule_wakeup` with a delay between one minute and one hour. When
  the wake-up fires, the same `/loop` input runs again. If the model ends a
  turn without scheduling the next one, One Code schedules a 20-minute
  fallback once; if that turn also schedules nothing, the loop ends. A
  self-paced loop also ends after seven days.
- **No prompt.** A bare `/loop` runs an autonomous check that keeps your
  current work moving (CI, review threads, unfinished steps), self-paced.
  `/loop 30m` runs the same check on a cron. If `.claude/loop.md` exists in
  the project (or `~/.claude/loop.md`), its tasks replace the autonomous
  check, and the model sees the file again whenever you edit it.

When a self-paced tick finds nothing to do (the model reports `noop: true`),
the next wake-up line counts the streak, for example `Resuming /loop wakeup
(2:04pm) · 2 no-op ticks since 2:02pm`, and those quiet ticks leave the
model's context, replaced by one line saying the loop is healthy. The ticks
stay visible above in the terminal.

A background subagent can schedule its own jobs with the same tools. It sees
and cancels only its own, a job it made fires into that agent while it is
still running, and the job is dropped once the agent has ended. The main
session's `cron_list` shows every job. A subagent that runs until its task is
done, such as one another subagent starts or any subagent in a `-p` run, can't
schedule a job: nothing would be left to receive it, so its `cron_create`
returns an error.

To stop a loop, ask the model to stop it, as in Claude Code. It cancels the
job with `cron_delete`, or ends a self-paced loop with `schedule_wakeup`.
Several loops can run at once. Set `ONECODE_LOOP_KEEPALIVE=0` to turn
off the fallback wake-up.

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
- After you interrupt a turn, or a turn ends on a provider error,
  notifications are held instead of starting a turn on their own. The held
  notifications ride your next prompt as one message, or go to the next turn
  that starts some other way, such as a skill you type. A monitor keeps a
  single batch while it waits. Scheduled prompts from `/loop` and
  `cron_create` are not held: they keep firing on schedule.
- Each notification is framed as an automated event, so the model doesn't
  mistake it for something you said or approved.

## Non-interactive runs

In `-p` and `--mode json` runs nothing can run in the background, because
the process exits when the turn settles. Background shells, monitors,
subagents, and workflows run to completion and return their output
directly. A shell command run this way stops at its `timeout`, or after two
minutes when the model gives none, and its result says why it stopped. `/loop`, `schedule_wakeup`, and scheduled prompts don't fire;
`cron_create` still creates the job, and its result says the job can never
fire.
