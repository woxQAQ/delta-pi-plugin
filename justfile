default: check

check:
    bun run check
    bun test

# Requires a locally installed Pi CLI; sends no model request.
smoke:
    bun scripts/smoke-pi.mjs
