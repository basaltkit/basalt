---
'@basaltkit/scheduler': minor
---

A schedule entry now has exactly one frequency. Chaining a second one (`.daily().monthly()`, `.daily().everyMinute()`, `.cron(...).daily()`) throws the new exported `ScheduleDefinitionError` with code `SCHEDULE_CONFLICT`, naming the entry and both calls. `.at('HH:mm')` combines only with `daily()`, `weekly()`, `monthly()` or no frequency, and may be called once; after `everyMinute()`, `everyMinutes()`, `hourly()` or `cron()` it throws `SCHEDULE_CONFLICT`. Day-of-week modifiers combined with `cron()` throw too. A malformed time (`at('25:00')`, `at('ab')`) throws `SCHEDULE_INVALID_TIME` instead of silently producing `NaN` fields. Frequencies no longer depend on call order: `.at('03:00').daily()` now means 03:00, and `.mondays().weekly()` means Mondays.

**Behaviour change:** entries that chained two frequencies used to run on whichever call came last, with no warning. They now throw `SCHEDULE_CONFLICT` at boot. Keep the one frequency you mean, for example `.monthly().at('03:00')`.
