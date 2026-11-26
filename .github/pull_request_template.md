## User story

HU-xx <!-- Replace xx with the user story number, e.g. HU-03 -->

## Summary

<!-- What changed and why, in two or three sentences. -->

## How it was tested

<!-- Commands run, manual checks and the result of each one. -->

## Quality Gates

- [ ] Lint passes (`npm run lint` in `api/` and `web/`)
- [ ] Type check passes (`npx tsc --noEmit` in `api/` and `web/`)
- [ ] Tests pass with coverage of at least 80% (`npm test -- --coverage`)
- [ ] Build passes (`npm run build`)
- [ ] Gitleaks reports no secrets
- [ ] Forbidden-words check reports nothing (`bash scripts/check-forbidden-words.sh`)
