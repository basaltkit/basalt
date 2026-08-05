import { parseDuration, type DurationInput } from '@machize/core'

const RealDate = globalThis.Date

let offset = 0
let installed = false

/**
 * Patched Date: shifts `now` by the travel offset. Explicit constructor
 * arguments are untouched — only "current time" moves.
 */
class ShiftedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + offset)
    else super(...(args as [number]))
  }

  static override now(): number {
    return RealDate.now() + offset
  }
}

function install(): void {
  if (installed) return
  globalThis.Date = ShiftedDate as DateConstructor
  installed = true
}

/**
 * Time travel without a test-runner dependency — works in any runner:
 *
 * time.travel('15d')       // trials expire, meters roll over
 * time.travelTo(new Date('2027-01-01'))
 * time.restore()           // always call in afterEach
 */
export const time = {
  travel(duration: DurationInput): void {
    install()
    offset += parseDuration(duration)
  },

  travelTo(date: Date): void {
    install()
    offset = date.getTime() - RealDate.now()
  },

  /** Undoes the patch and resets the offset. */
  restore(): void {
    offset = 0
    if (installed) {
      globalThis.Date = RealDate
      installed = false
    }
  },
}
