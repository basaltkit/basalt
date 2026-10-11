---
"create-basalt": minor
---

`update` adds a required `@basaltkit/*` peer the app's `package.json` does not list. On an app scaffolded by create-basalt 1.12 or earlier, moving `@basaltkit/testing` to 3 left `@basaltkit/mailer` out of the manifest: the app only worked because pnpm and npm install peers on their own, and failed under yarn PnP, `auto-install-peers=false` or `--legacy-peer-deps`. The plan now adds such a peer at its latest version (in `dependencies` when a runtime dependency needs it, else `devDependencies`) and lists it under "Required peers the app did not list (added)"; when the registry, the release-age window or the peer's range rules that out, it warns with the `add` command instead. Optional peers (`peerDependenciesMeta`) are never added. `UpdatePlan` gains `addedPeers`, and `LatestInfo` gains `optionalPeers`.
