import { createToken, definePlugin } from '@basaltkit/core'
import { I18n, type I18nOptions } from './i18n.js'
import type { Catalog } from './messages.js'

export const I18N = createToken<I18n<Catalog>>('i18n')

/**
 * Registers an {@link I18n} instance under the `I18N` token. The generic
 * catalog type is erased at the token; import your typed instance directly (or
 * cast) to keep key autocompletion.
 */
export function i18nPlugin<C extends Catalog>(options: I18nOptions<C>) {
  return definePlugin({
    name: 'basalt:i18n',
    register({ container }) {
      container.singleton(I18N, () => new I18n(options) as I18n<Catalog>)
    },
  })
}
