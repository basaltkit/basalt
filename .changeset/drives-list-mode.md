---
"@basaltkit/drives": minor
"@basaltkit/drives-google": minor
"@basaltkit/drives-dropbox": minor
"@basaltkit/drives-microsoft": minor
---

Per-call listing mode: `DriveListOptions.recursive?: boolean` (`listItems(id, { recursive })`). `true` lists the subtree, `false` a folder's direct children; omitted, each adapter keeps its constructor default exactly as before. Google honours both (`recursive: false` on an unscoped connection lists the account root's children), Dropbox passes it to `list_folder`, and Microsoft — which has no recursive listing — refuses `recursive: true` with `DRIVE_UNSUPPORTED` (`recursiveList`) instead of silently returning one level. An explicit mode is bound into the engine's page cursor (new `bkl2` envelope; default-mode cursors keep `bkl1`): a continuation that omits `recursive` keeps the cursor's mode, one that changes it is refused.
