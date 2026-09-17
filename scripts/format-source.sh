#!/usr/bin/env bash
set -euo pipefail
npx --yes prettier@3.6.2 --write 'src/**/*.{ts,tsx,css}' 'scripts/*.{ts,mjs}' 'tests/**/*.ts' '*.ts' '*.json'
