#!/usr/bin/env bash
# Post-deploy smoke test for the public Distribution.
#
# Checks GET /, GET /api/v1/health, GET /docs/ and GET /docs/openapi.json:
# status 200 and the six security headers on every check. The health body must
# be {"status":"ok"}. The docs page must also send a content-security-policy
# that contains "img-src 'self' data:" (the docs policy allows data: images).
# Requests never send X-Origin-Verify, so a passing run proves that CloudFront
# adds it.
#
# Usage: scripts/smoke-test.sh <base-url>   (the URL must start with https://)
# Environment: SMOKE_RETRY_DELAY seconds between attempts (default 5).
set -euo pipefail
readonly MAX_ATTEMPTS=5
readonly HEALTH_PATH="/api/v1/health"
readonly HEALTH_BODY='{"status":"ok"}'
readonly DOCS_PATH="/docs/"
readonly OPENAPI_PATH="/docs/openapi.json"
readonly DOCS_IMG_SRC="img-src 'self' data:"
readonly REQUIRED_HEADERS=(
  strict-transport-security
  content-security-policy
  x-content-type-options
  x-frame-options
  referrer-policy
  permissions-policy
)
REASON=""
usage() {
  echo "Usage: $(basename "$0") <base-url>" >&2
  echo "  Optional environment: SMOKE_RETRY_DELAY=<seconds> (default 5)" >&2
}
if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  usage
  exit 2
fi
if [[ "$1" != https://* ]]; then
  echo "The base URL must start with https://" >&2
  usage
  exit 2
fi
readonly BASE_URL="${1%/}"
readonly RETRY_DELAY="${SMOKE_RETRY_DELAY:-5}"
if ! [[ "$RETRY_DELAY" =~ ^[0-9]+$ ]]; then
  echo "SMOKE_RETRY_DELAY must be a whole number of seconds" >&2
  exit 2
fi
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
readonly HEADERS_FILE="$WORK_DIR/headers.txt"
readonly BODY_FILE="$WORK_DIR/body.txt"
# Succeeds when the header named $1 appears in the response (case-insensitive).
has_header() {
  awk -v name="$1" '
    {
      line = tolower($0)
      sub(/\r$/, "", line)
      if (index(line, tolower(name) ":") == 1) found = 1
    }
    END { exit found ? 0 : 1 }
  ' "$HEADERS_FILE"
}
# Prints the value of the header named $1 (case-insensitive, leading spaces removed).
header_value() {
  awk -v name="$1" '
    {
      line = $0
      sub(/\r$/, "", line)
      if (index(tolower(line), tolower(name) ":") == 1) {
        value = substr(line, length(name) + 2)
        sub(/^[ \t]+/, "", value)
      }
    }
    END { printf "%s", value }
  ' "$HEADERS_FILE"
}
# Validates the response in HEADERS_FILE and BODY_FILE.
# $1 is the check kind: page, plain, health (body must match) or docs (CSP must allow data: images).
# Sets REASON on failure.
validate_response() {
  local kind="$1"
  local status header csp
  status="$(awk '/^HTTP\//{ code = $2 } END { print code }' "$HEADERS_FILE")"
  if [ "$status" != "200" ]; then
    REASON="status ${status:-none}"
    return 1
  fi
  for header in "${REQUIRED_HEADERS[@]}"; do
    if ! has_header "$header"; then
      REASON="missing header $header"
      return 1
    fi
  done
  case "$kind" in
    health)
      if [ "$(cat "$BODY_FILE")" != "$HEALTH_BODY" ]; then
        REASON="unexpected health body"
        return 1
      fi
      ;;
    docs)
      csp="$(header_value content-security-policy)"
      if [[ "$csp" != *"$DOCS_IMG_SRC"* ]]; then
        REASON="content-security-policy without $DOCS_IMG_SRC"
        return 1
      fi
      ;;
  esac
  return 0
}
# run_check <check-name> <path> <kind: page | plain | health | docs>
run_check() {
  local name="$1" path="$2" kind="$3"
  local attempt
  REASON="no attempt was made"
  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    : >"$HEADERS_FILE"
    : >"$BODY_FILE"
    if curl -sS --proto '=https' --max-time 30 -D "$HEADERS_FILE" -o "$BODY_FILE" "${BASE_URL}${path}"; then
      if validate_response "$kind"; then
        echo "OK: $name"
        return 0
      fi
    else
      REASON="request failed"
    fi
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
      sleep "$RETRY_DELAY"
    fi
  done
  echo "FAILED: $name $REASON" >&2
  return 1
}
run_check "GET /" "/" page || exit 1
run_check "GET $HEALTH_PATH" "$HEALTH_PATH" health || exit 1
run_check "GET $DOCS_PATH" "$DOCS_PATH" docs || exit 1
run_check "GET $OPENAPI_PATH" "$OPENAPI_PATH" plain || exit 1
echo "All smoke checks passed"
