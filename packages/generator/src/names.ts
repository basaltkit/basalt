/** The many casings of a resource name, derived once from any input form. */
export interface Names {
  /** Original input. */
  raw: string
  /** `Project`, `BlogPost` */
  pascal: string
  /** `project`, `blogPost` */
  camel: string
  /** `project`, `blog-post` */
  kebab: string
  /** `projects`, `blog-posts` — used for route paths. */
  pluralKebab: string
  /** `PROJECT`, `BLOG_POST` — token / error-code prefix. */
  constant: string
}

function toWords(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
}

const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1)

/** Naive English pluralization — good for identifiers, override where it matters. */
function pluralize(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`
  return `${word}s`
}

export function names(input: string): Names {
  const words = toWords(input)
  if (words.length === 0) throw new Error(`Cannot derive a name from "${input}".`)

  const pascal = words.map(capitalize).join('')
  const kebabWords = [...words]
  const last = kebabWords.length - 1
  kebabWords[last] = pluralize(kebabWords[last] as string)

  return {
    raw: input,
    pascal,
    camel: pascal.charAt(0).toLowerCase() + pascal.slice(1),
    kebab: words.join('-'),
    pluralKebab: kebabWords.join('-'),
    constant: words.join('_').toUpperCase(),
  }
}
