---
"create-machize": patch
---

Exit cleanly on Ctrl+C during the interactive prompts. Previously aborting a
prompt dumped a raw Node `AbortError` stack trace; now it prints "Cancelled."
and exits with code 130.
