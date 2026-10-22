/**
 * The catalog format of @basaltkit/i18n (its import-free subpath). The build
 * replaces this module in dist/client with the package's own compiled file
 * (scripts/vendor-client.mjs): the page loads no bare specifier, and the
 * published UI does not depend on @basaltkit/i18n at run time.
 */
export { defineMessages, render, type Catalog, type MessageValue } from '@basaltkit/i18n/messages'
