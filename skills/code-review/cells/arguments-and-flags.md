## Arguments and flags

Read the invocation arguments and adjust accordingly:

- **A target** (`<pr#>`, `<branch>`, or `<path>`) replaces "the current diff" as
  the review scope in Phase 0.
- **`--comment`** — after producing the findings list, if the review target is a
  GitHub PR, post each finding as an inline PR comment (one call per finding;
  include a suggestion block only when it fully fixes the issue). Prefer a
  GitHub inline-comment MCP tool if one is connected this session; otherwise use
  `gh api repos/{owner}/{repo}/pulls/{pr}/comments`. If the target is not a PR,
  print the findings to the terminal and note that `--comment` was ignored.
- **`--fix`** — after producing the findings list, apply the findings to the
  working tree instead of stopping at the report: fix each one directly —
  correctness bugs and reuse/simplification/efficiency cleanups alike. Skip any
  finding whose fix would change intended behavior, require changes well outside
  the reviewed diff, or that you judge to be a false positive — note the skip
  rather than arguing with it. Finish with a brief summary of what was fixed and
  what was skipped.
