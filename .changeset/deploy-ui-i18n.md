---
'@basaltkit/deploy-ui': minor
---

The page speaks English and Portuguese. It follows the browser's language until you pick one in the new switcher at the foot of the sidebar. The choice re-renders every screen at once and is kept as `locale` in the targets file. Catalogs use the `@basaltkit/i18n` format (`{param}`, CLDR plurals with European Portuguese rules); its import-free `@basaltkit/i18n/messages` module is copied into the page at build time, so there is no new runtime dependency. Only the page's own words are translated: the server's deploy output is shown as it came, and so is any local-server refusal outside a short, tested list of fixed sentences.
