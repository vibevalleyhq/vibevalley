---
name: Code review
description: When you are asked to review a branch, an issue's changes or a piece of code: read only, never change anything, and list findings by severity with file and line.
---

A review reads and never writes: no commits, no edits, no rewriting someone else's code. What you hand back is an opinion.

1. **Find out what to review.** For an issue's changes, read its branch's diff against the base (`git diff <base>...HEAD`) and what the issue asked for; for a piece of code, the files the user pointed at. For a large change, read it all once before going file by file.
2. **Look in this order:**
   - **Correctness**: logic errors, edges (empty, zero, maximum, duplicates, concurrency, timeouts), errors handled or swallowed, resources released, callers elsewhere broken. Check it actually does what the issue asked.
   - **Security**: inputs validated; no keys, paths or user data leaking out; no permission bypassed.
   - **Tests**: changed behaviour is tested; tests check behaviour, not implementation details; a bug fix adds a test that reproduces it. Run the repository's tests if you can, and say what you ran and how it went.
   - **Clarity**: names say what they do; duplicated logic that could reuse what exists; comments only say what the code can't. Where the repository has its own rules (`AGENTS.md`, `CONTRIBUTING`, lint config), follow them.
3. **Every finding must hold up.** Say which file and line, what is wrong, with what input it fails, and how to fix it. Mark what you're unsure of as a question, not a verdict; leave out what you can't back up.
4. **Report format:**

   ```
   Verdict: merge / merge after fixes / don't merge, in one sentence why

   Severe (breaks or is unsafe)
   - path/to/file.ts:42 — the problem; when it fails; the fix

   Should fix
   - ...

   Minor (optional)
   - ...

   Ran: vp test run src/foo (passed / the failing output)
   ```

   If nothing is wrong, say "found nothing wrong" and what you read and ran. Don't nitpick to look thorough.

Write the review in the user's language.
