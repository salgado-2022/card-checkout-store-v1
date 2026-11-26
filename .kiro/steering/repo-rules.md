---
inclusion: always
---
# Repository rules (breaking one can disqualify the submission)

1. **The payment provider's company name must never appear in the repository** — not in code, tests, fixtures, variable names, comments, README, docs, specs, branch names or commit messages. Always use the generic term `payment`. The forbidden words live in `.kiro/private/forbidden-words.txt` (git-ignored); `bash scripts/check-forbidden-words.sh` must report nothing before every commit. Do not add links to the provider's documentation.
2. **No secrets in the repo.** Private key (`prv_…`), integrity secret and events secret live only in SSM (deployed) and in the git-ignored `.env` (local). `.env.example` contains variable names only. The frontend bundle may contain only the public key.
3. **Card data** (full number, CVC, expiry) never leaves the browser except in the tokenization request to the provider; it is never persisted, logged, put in URLs or sent to our API.
4. **Language:** UI text in Spanish; code, identifiers, comments, commits, PRs, README and docs in English.
5. **History matters:** small commits and one PR per user story. Agents never commit or push; the developer does.
6. Never run `terraform apply`/`destroy` or call the provider with real keys from an agent; the developer does it.
