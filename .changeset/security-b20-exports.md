---
'@basaltkit/exports': patch
---

security(exports): the CSV/TSV formula-injection guard now checks the final rendered text of every value except primitive numbers, bigints and booleans — arrays, objects, boxed strings and dates (after rendering) included — and also neutralises a leading line feed, the full-width `＝ ＋ － ＠` forms and triggers preceded by whitespace.
