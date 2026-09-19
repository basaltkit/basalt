---
'@basaltkit/sdk': patch
---

security: path params are now substituted by whole placeholder name in a single pass, and a missing, empty, `.` or `..` value throws `CLIENT_INVALID_PARAM` before the request is sent, so a param value can no longer redirect an authenticated call to a different same-origin endpoint.
