# Debugging

## Purpose
Systematically identify and fix the root cause of software failures.

## When to use
Use when code produces errors, crashes, incorrect results, unexpected behavior, or regressions.

## Procedure
1. Reproduce the problem.
2. Capture the exact error and relevant context.
3. Narrow the failure to the smallest responsible component.
4. Form hypotheses based on evidence.
5. Test hypotheses one at a time.
6. Fix the root cause.
7. Verify the original failure and check for regressions.

## Rules
- Do not guess when evidence can be collected.
- Distinguish symptoms from root causes.
- Avoid unrelated refactoring during a focused fix.
- Explain the cause and why the fix works.
