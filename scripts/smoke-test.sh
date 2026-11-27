#!/usr/bin/env bash
# Post-deploy smoke test for the public Distribution.
#
# Checks GET / and GET /api/v1/health: status 200, the six security headers
# and, for health, the body {"status":"ok"}. Requests never send
# X-Origin-Verify, so a passing run proves that CloudFront adds it.
#
# Usage: scripts/smoke-test.sh <base-url>   (the URL must start with https://)
# Environment: SMOKE_RETRY_DELAY seconds between attempts (default 5).
set -euo pipefail

readonly MAX_ATTEMPTS=5
readonly HEALTH_PATH="/api/v1/health"
readonly HEALTH_BODY='{"status":"ok"}'
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

# Validates the response in HEADERS_FILE and BODY_FILE.
# $1 is 1 when the health body must also match. Sets REASON on failure.
validate_response() {
  local check_health="$1"
  local status header

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

  if [ "$check_health" = "1" ] && [ "$(cat "$BODY_FILE")" != "$HEALTH_BODY" ]; then
    REASON="unexpected health body"
    return 1
  fi

  return 0
}

# run_check <check-name> <path> <1 for health body check | 0 otherwise>
run_check() {
  local name="$1" path="$2" check_health="$3"
  local attempt

  REASON="no attempt was made"
  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    : >"$HEADERS_FILE"
    : >"$BODY_FILE"

    if curl -sS --proto '=https' --max-time 30 -D "$HEADERS_FILE" -o "$BODY_FILE" "${BASE_URL}${path}"; then
      if validate_response "$check_health"; then
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

run_check "GET /" "/" 0 || exit 1
run_check "GET $HEALTH_PATH" "$HEALTH_PATH" 1 || exit 1
echo "All smoke checks passed"
