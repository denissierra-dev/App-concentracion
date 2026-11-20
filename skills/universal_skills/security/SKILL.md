# Security

## Purpose
Identify and prevent security weaknesses throughout development.

## When to use
Use when handling authentication, authorization, secrets, user data, networking, file operations, dependencies, external input, or deployment.

## Procedure
1. Identify trust boundaries and sensitive assets.
2. Treat external input as untrusted.
3. Check authentication and authorization.
4. Check validation, encoding, and injection risks.
5. Check secret handling and data exposure.
6. Check dependencies and configuration.
7. Verify fixes without introducing new weaknesses.

## Rules
- Never hard-code secrets.
- Follow least privilege.
- Do not expose sensitive data in logs or errors.
- Prefer established secure libraries and documented practices.
- Security requirements take precedence over convenience.

## Package Manager Policy
- Use `pnpm` exclusively for installing, updating, and running Node.js dependencies and scripts.
- Never use `npm` (or generate `package-lock.json`); strict dependency isolation and lockfile integrity via `pnpm-lock.yaml` are mandatory.
