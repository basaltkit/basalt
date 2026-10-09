---
'@basaltkit/exports': minor
---

CSV import (BK-086): `parseDelimited(input, { delimiter, quote, bom, maxRows, maxFieldLength })` is a strict RFC 4180 async iterator of `{ line, cells }` over a string, bytes or an async iterable of chunks, with physical line numbers across quoted line breaks; malformed input throws `DelimitedParseError` (`CSV_UNTERMINATED_QUOTE`, `CSV_INVALID_QUOTE`, `CSV_TOO_MANY_ROWS`, `CSV_FIELD_TOO_LARGE`, `CSV_BOM_FORBIDDEN`, `CSV_INVALID_ENCODING`), with limits enforced while streaming. `defineImport` + `readImport` map headers by folded name (case, accents, whitespace; synonyms), parse `'text' | 'integer' | 'decimal' | 'date' | fn` with the shared `LocaleSpec` — strict decimals (`'12.5'` with a comma decimal is `AMBIGUOUS_DECIMAL`, `'1.250,50'` is 1250.5) and calendar-validated dates — and return `{ rows, errors, warnings }` with `{ line, column, code, message }` issues, never throwing on bad data and returning no rows for a malformed file.
