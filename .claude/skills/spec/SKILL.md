---
name: spec
description: Turn an approved hypothesis (or a raw idea) into an agent-ready GitHub issue with acceptance criteria. Argument — hypothesis id from PRODUCT.md or free text.
---

Delegate to `product` in Mode B with: $ARGUMENTS. If it's an H<n> id, tell it to read the card from PRODUCT.md hypothesis log.

Show the spec to the owner and ask for one of: `approve`, edits, or `drop`.

On `approve`:
- Create the issue: `gh issue create --title "<title>" --body-file <tmp> --label agent-ready`
- If the spec proposed a split, create one issue per part with the order in the body, label only the first one `agent-ready`.
- Print the issue URL(s).

Do not start implementation from here. The factory or `/feature` picks it up.
