/**
 * Splits a command line the way a POSIX shell splits words (quote removal
 * included), for the checks on the remote command: '…' is literal, "…" keeps
 * \ before $ ` " \ and newline, a backslash outside quotes escapes the next
 * character. Expansions are not performed: a word containing an unquoted
 * $, `, ;, |, <, >, (, ) or & (other than the && between two commands) is
 * reported, because it would be one.
 */
export function posixWords(line) {
  const words = []
  const unquotedSpecials = []
  let word = ''
  let inWord = false
  let i = 0
  const push = () => { if (inWord) words.push(word); word = ''; inWord = false }
  while (i < line.length) {
    const c = line[i]
    if (c === ' ' || c === '\t' || c === '\n') { push(); i++; continue }
    inWord = true
    if (c === "'") {
      const end = line.indexOf("'", i + 1)
      if (end === -1) throw new Error('unterminated single quote')
      word += line.slice(i + 1, end)
      i = end + 1
      continue
    }
    if (c === '"') {
      i++
      for (;;) {
        if (i >= line.length) throw new Error('unterminated double quote')
        const d = line[i]
        if (d === '"') { i++; break }
        if (d === '\\' && i + 1 < line.length && '$`"\\\n'.includes(line[i + 1])) { word += line[i + 1]; i += 2; continue }
        if (d === '$' || d === '`') unquotedSpecials.push(d)
        word += d
        i++
      }
      continue
    }
    if (c === '\\') {
      if (i + 1 < line.length) word += line[i + 1]
      i += 2
      continue
    }
    if ('$`;|<>()&'.includes(c)) unquotedSpecials.push(c)
    word += c
    i++
  }
  push()
  return { words, unquotedSpecials }
}
