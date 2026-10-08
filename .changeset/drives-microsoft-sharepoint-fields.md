---
"@basaltkit/drives-microsoft": minor
---

Add an opt-in `listItemFields` option: an allow-list of SharePoint column internal names expanded (`$expand=listItem($expand=fields($select=…))`) on listings, `getItem` and the change feed. Values are flattened to primitives under `item.raw.listItemFields` (lookup/managed-metadata labels, person emails, multi-values joined with `"; "`; at most 64 columns, 1 KB per value) and read with the new `sharePointFieldsOf(item)` helper. With the option unset, `raw` stays exactly `{ driveId }`; a personal OneDrive has no list item, so the key is absent. No change to the drives core contract.
