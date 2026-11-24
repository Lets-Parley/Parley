# Issues Addressed in This PR

## Issue #1034 - ✅ COMPLETED
**refactor(poker): name the 15-second publication call timeout**

- Added `providerCallTimeout` constant in the `publication` package
- Replaced hardcoded `15*time.Second` values at:
  - `internal/poker/publication/verify.go:102`
  - `internal/poker/publication/run.go:125`
- Added documentation comment explaining what the constant bounds

## Issue #1033 - ⚠️ REQUIRES ENVIRONMENT SETUP
**chore(web): fix unused-variable and unsafe-optional-chaining lint warnings in tests**

This issue requires:
1. Node.js environment with `npm` properly configured
2. Installation of web dependencies (`cd web && npm install`)
3. Running `npm run lint` to identify exact line numbers of warnings
4. Fixing the 4 warnings in test files

**Current Status:** Cannot complete without proper Node.js development environment setup on Windows system. The linter (oxlint) is not currently available.

**What needs to be done:**
- 2 × `eslint(no-unused-vars)` in `src/lib/useSession.test.tsx`
- 1 × `eslint(no-unsafe-optional-chaining)` in `src/pages/CatalogPage.test.tsx`
- 1 × `eslint(no-unsafe-optional-chaining)` in `src/pages/SpacePage.test.tsx`
