# Platform foundation: deployment evidence

Verified on 2026-11-26 after the first run of `deploy.yml` (all five jobs green).

Public URL: https://dfpcn2xoevh6g.cloudfront.net

| Check | Command | Result |
|---|---|---|
| Web over HTTPS with the six security headers | `curl -sI https://<domain>/` | `HTTP/2 200`, HSTS, CSP, nosniff, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy |
| Health through CloudFront | `curl -s https://<domain>/api/v1/health` | `{"status":"ok"}` |
| SPA deep link | `curl -s -o /dev/null -w '%{http_code}' https://<domain>/some/deep/route` | `200` (index.html) |
| Unknown API route | `curl -s https://<domain>/api/v1/unknown` | JSON 404 error envelope, not HTML |
| HTTP redirect | `curl -s -o /dev/null -w '%{http_code}' http://<domain>/` | `301` to HTTPS |
| Direct Function URL (bypassing CloudFront) | `curl -s -o /dev/null -w '%{http_code}' <function-url>api/v1/health` | `403` (origin guard) |
| Mozilla HTTP Observatory | https://developer.mozilla.org/en-US/observatory | **A+**, score 115/100, 12/12 tests passed |
