# Single-Block Focus

## Purpose
Ensure the AI agent works on one clearly defined block (phase, feature, or task) at a time without mixing scopes or jumping ahead.

## When to use
Always use during multi-phase roadmaps, feature development, refactoring, or any task that can be divided into sequential blocks.

## Procedure
1. Identify the single active block to work on and state its exact scope before writing code.
2. Execute only the changes, files, and tests required for that active block.
3. Verify the block completely (typecheck, build, tests, or relevant checks).
4. Summarize what was completed in the current block and stop.
5. Propose the next single block and wait for user confirmation before starting it.

## Rules
- Never combine multiple roadmap phases or unrelated blocks in the same turn unless explicitly requested by the user.
- Do not implement speculative code, endpoints, or UI for future blocks.
- Keep edits, tests, and verification strictly scoped to the active block.
- If a blocker or dependency from another block is discovered, pause, report it, and ask how to proceed before expanding scope.
