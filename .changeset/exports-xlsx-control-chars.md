---
'@basaltkit/exports-xlsx': patch
---

Cells containing XML control characters no longer produce a workbook Excel refuses to open.

`escapeXml` handled `& < > " '` but passed `0x00`–`0x08`, `0x0B`, `0x0C` and `0x0E`–`0x1F` straight through. XML 1.0 forbids them outright, so a single one — easily present in user-supplied data — made the whole sheet unparseable. They are now written with OOXML's `_xHHHH_` escape, and a literal `_xHHHH_` in the data is escaped first so the encoding round-trips. Tab, newline and carriage return are legal XML and stay verbatim.
