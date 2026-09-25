---
name: loop
description: 'Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo). Omit the interval to let the model self-pace. - When the user wants to set up a recurring task, poll for status, or run something repeatedly on an interval (e.g. "check the deploy every 5 minutes", "keep running /babysit-prs"). Do NOT invoke for one-off tasks.'
argument-hint: "[interval] [prompt]"
---

One Code builds this skill's instructions from its arguments when it runs
(`extensions/background/loop-skill.ts`, Claude Code's `/loop`). This text shows
only when the background extension is not loaded: tell the user `/loop` needs
it, and do not schedule anything.
