---
name: product
description: Generate product hypotheses for the owner to score. Run periodically (weekly) or when the backlog is thin. Argument optional — a theme or constraint to focus on.
---

Delegate to `product` in Mode A. Pass: $ARGUMENTS as the focus (may be empty → open-ended), and remind it to load PRODUCT.md, its memory, and open issues first.

Show the owner the cards and the "Owner's call" table verbatim. Then stop. Do not implement anything.

When the owner replies with scores:
1. Append the scored table to `PRODUCT.md` under "## Hypothesis log" with today's date.
2. Move anything scored 1 to the "## Rejected" section with the owner's note.
3. For anything scored 4–5, offer to run `/spec H<n>`.
4. Delegate to `product` once more with the scores so it updates its memory.
