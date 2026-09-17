#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
fail=0

if git grep -I -E -e 'BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY' -- . >/tmp/btcbet-pem.txt; then
  echo "PEM/private key material found:"
  cat /tmp/btcbet-pem.txt
  fail=1
fi

if git grep -I -E -e 'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}' -- . >/tmp/btcbet-tokens.txt; then
  echo "Cloud/API token material found:"
  cat /tmp/btcbet-tokens.txt
  fail=1
fi

if git grep -I -E -e '/home/[A-Za-z0-9._-]+/' -- . >/tmp/btcbet-home.txt; then
  echo "Absolute home-directory paths found:"
  cat /tmp/btcbet-home.txt
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
echo "secret-scan: no private keys, tokens, or home paths found"
