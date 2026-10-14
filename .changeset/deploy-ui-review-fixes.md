---
'@basaltkit/deploy-ui': patch
---

Fixes from the independent review of the local UI (RFC 0009 §15):

- **The server proves itself.** The session exchange also returns a server key that the page never sends. After every load, and before any `.env` answer leaves the page, the server must answer a fresh nonce with `HMAC-SHA256(serverKey, …)`. A process that takes the port after the UI stopped gets no answer. When the server is gone or fails the proof, the page empties its forms, forgets the `sessionStorage` session (Quit does too) and says so.
- **Targets file ownership.** The file is refused when another user owns it, or when any directory up to `/` is owned by another user (root excepted) or writable by others without the sticky bit. Saves are checked the same way. `run`, `env` and `rollback` carry the target the confirmation showed, and if the file changed since, the server answers 409 and sends nothing.
- **Windows.** `ssh.exe` and `rundll32.exe` are resolved to absolute paths, so a planted binary in the current folder is never run. ssh and the opener start in the home directory on every OS.
- **Cancel.** The first cancel is sent as `cancel --first-only`. When the server says the run was already cancelled (from a terminal or an earlier UI session), the page asks for the second confirmation instead of sending the immediate signal.
- **Attach.** A stream cut mid-line is resumed from the last complete event instead of being reported as corrupt. Re-attaching after a run has ended finishes at once with the run's exit code, where it used to reconnect for up to 10 minutes, and the page then offers only a replay.
- **Idle shutdown** waits for a command still in flight, such as a slow plan or a run that is detaching, not only for open streams.
- Destructive dialogs open with focus on *Cancel*. A resumed step whose start came before the resume point is named by its id.
