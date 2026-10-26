---
paths:
  - "src/catalog.ts"
  - "src/store.ts"
  - "src/files.ts"
---

# What we store

- `src/catalog.ts` must never gain a file-copy path. Its only write target is `index.json`.
- Nothing persisted holds raw transcript text. What is stored is redacted at construction.
- Writes go through `writeAtomic` (temp file with the pid, then rename).
