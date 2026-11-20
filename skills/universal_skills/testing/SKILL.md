# Testing

## Purpose
Verify that software behaves correctly and remains reliable after changes.

## When to use
Use when implementing features, fixing bugs, refactoring, or validating behavior.

## Procedure
1. Identify expected behavior.
2. Cover normal, boundary, invalid, and failure cases where relevant.
3. Write focused tests.
4. Run the relevant test suite.
5. Investigate failures rather than hiding them.
6. Add regression tests for fixed bugs.

## Rules
- Tests should be deterministic when practical.
- Prefer behavior-focused tests over implementation details.
- Do not weaken tests merely to make them pass.
- Keep tests understandable and maintainable.
