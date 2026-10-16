---
'@basaltkit/deploy': patch
---

SeaweedFS: 1 GB volumes and an explicit volume count (`-master.volumeSizeLimitMB=1024 -volume.max=1000`). By default SeaweedFS allows (free disk / 30 GB) volumes and grows seven per bucket: on a server with little free disk the second bucket had none, and every write to it was a 500 (`No writable volumes and no free volumes left`). Volumes take no disk until they hold data. The next deploy recreates the container with the new command; the data stays in its volume.
