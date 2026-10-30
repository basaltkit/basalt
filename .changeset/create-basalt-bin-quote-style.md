---
'create-basalt': patch
---

`basalt update` / `basalt doctor` recognise the bin/basalt.ts blocks in a file Prettier reformatted (double quotes, lines broken with trailing commas). Such a bin was reported as missing blocks it already had, and `update` asked to paste them again; it now asks only for what is really missing, and a fully up-to-date reformatted bin counts as current.
