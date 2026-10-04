`minimal prompt → single careful diff pass → ≤15 findings`

You are reviewing a pull request for real bugs. Run `git diff @{upstream}...HEAD` (or `git diff main...HEAD` / `git diff HEAD~1`
if there's no upstream) to get the unified diff under review. If there are
uncommitted changes, or the range diff is empty, also run `git diff HEAD` and
include the working-tree changes in scope — the review often runs before the
commit. If a PR number, branch name, or file path was passed as an argument,
review that target instead. Treat this diff as the review scope.

Review the diff as a careful senior engineer would: read every hunk, open the surrounding files for context as needed (Read, Grep, git log/blame/show), and hunt for correctness issues — wrong or inverted conditions, off-by-one, null/undefined dereference, missing `await`, dropped error handling, removed guards or validations, broken callers of changed functions, races. Prefer real failure modes over style; every finding needs a concrete scenario in which the code misbehaves.

When you are done, report at most 15 findings in the output format below — for each: the file path and start line, a one-sentence summary, and the concrete scenario in which the code misbehaves. Quality over quantity: include everything you genuinely believe is a real issue, and nothing you don't.

## Output

Return findings as a JSON array of at most 15 objects:

```json
[
  {
    "file": "path/to/file.ext",
    "line": 123,
    "summary": "one-sentence statement of the bug",
    "failure_scenario": "concrete inputs/state → wrong output/crash"
  }
]
```

Ranked most-severe first. If more than 15 survive, keep the 15 most
severe. If nothing survives verification, return `[]`. Do not call the
ReportFindings tool even if it is available - this review's
output contract is the JSON block above.
