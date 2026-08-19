## What and why

<!-- One or two lines. What changes, and what problem it solves. -->

## Type

<!-- Prefix the PR title too, e.g. "fix: status line blank when cost is missing" -->

- [ ] `fix` — something behaved differently than documented
- [ ] `feat` — new signal, command or behaviour
- [ ] `perf` — the status line or a hook got cheaper
- [ ] `docs` — README, CHANGELOG or comments only
- [ ] `test` — coverage, fixtures, benchmarks
- [ ] `chore` — tooling, CI, dependencies

## Checks

- [ ] `npm run check` passes (typecheck + 103 tests)
- [ ] New behaviour has a test that fails without the change
- [ ] No new runtime dependency
- [ ] No network call in `src/`

## Still true after this change?

- [ ] Every hook exits 0, whatever happens
- [ ] No tool call is ever denied by default
- [ ] Nothing is added to the model's context by default
- [ ] A number the README states is produced by a test or a benchmark

<!-- If you had to tick "no" on any of these, say why here — sometimes it is the right call. -->
