#!/bin/bash
# Cloud sessions only: install npm packages so `npm run build` and `npm test` work.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# The tests expect Node 20 (`node --test tests/` takes a folder, and the badge tests set
# globalThis.navigator, which Node 22 makes read-only). The cloud image ships Node 20 in /opt.
if [ -x /opt/node20/bin/node ]; then
  export PATH="/opt/node20/bin:$PATH"
  if [ -n "${CLAUDE_ENV_FILE:-}" ] && ! grep -qs node20 "$CLAUDE_ENV_FILE"; then
    echo 'export PATH="/opt/node20/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
  fi
fi

cd "$CLAUDE_PROJECT_DIR"
npm install --no-audit --no-fund
