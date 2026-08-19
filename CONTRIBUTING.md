# Contributing

```bash
npm ci
npm test          # 100 tests, node's built-in runner, no framework
npm run typecheck # tsc --checkJs --noEmit, strict — src and test
npm run bench     # cold-start cost of the status line and the hooks
npm run check     # typecheck + test, what CI runs
```

CI runs the whole matrix: Linux, macOS and Windows on Node 20, 22 and 24.

## Adding a language

`keywords` on a profile is a map of language tag to phrases. Add a key, add phrases,
add a case to `test/detect.test.js`. Detection reads every language in the map, so no
other change is needed.

## Rules this code is held to

1. **A hook never breaks a session.** Every hook exits 0, including when a module fails
   to load.
2. **Nothing is added to the conversation by default.** `systemMessage` is free;
   `additionalContext` is billed to the user. Only the opt-in profile question may use it.
3. **Nothing fails towards zero.** A meter that reads $0.00 because it stopped
   understanding its input must say so.
4. **No network calls in `src/`.** Asserted by `test/integrity.test.js`.
5. **Claims are measured, not asserted.** If the README states a number, a test or a
   benchmark produces it.

## Releasing

Once a trusted publisher is configured on npm (npmjs.com → package → Settings →
Trusted Publisher → GitHub Actions, workflow `release.yml`):

```bash
npm version patch && git push --follow-tags
```

GitHub mints a short-lived OIDC token, npm verifies it came from this workflow in this
repository, and publishes with a provenance attestation. No secret is stored anywhere.
