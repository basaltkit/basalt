/**
 * Per-user notification preferences — richer and persistable, beyond the inline
 * `Notifiable.channelPreferences` opt-out. A preference targets a notification
 * name (or `*`) and a channel (or `*`); the **most specific** match wins, and
 * everything is opt-out by default (allowed unless a matching preference says
 * `enabled: false`).
 */
export interface NotificationPreference {
  userId: string
  /** Notification name, or `*` for all. */
  notification: string
  /** Channel name, or `*` for all channels. */
  channel: string
  enabled: boolean
}

export interface PreferenceStore {
  set(preference: NotificationPreference): Promise<void>
  /** All preferences for a user. */
  list(userId: string): Promise<NotificationPreference[]>
  remove(userId: string, notification: string, channel: string): Promise<void>
}

export class MemoryPreferenceStore implements PreferenceStore {
  private readonly prefs = new Map<string, NotificationPreference>()
  private key(u: string, n: string, c: string): string {
    return `${u}::${n}::${c}`
  }
  async set(preference: NotificationPreference): Promise<void> {
    this.prefs.set(this.key(preference.userId, preference.notification, preference.channel), { ...preference })
  }
  async list(userId: string): Promise<NotificationPreference[]> {
    return [...this.prefs.values()].filter((p) => p.userId === userId).map((p) => ({ ...p }))
  }
  async remove(userId: string, notification: string, channel: string): Promise<void> {
    this.prefs.delete(this.key(userId, notification, channel))
  }
}

/** Specificity: exact > notification-wide > channel-wide > global. */
function specificity(p: NotificationPreference, notification: string, channel: string): number {
  const nMatch = p.notification === notification
  const cMatch = p.channel === channel
  if (p.notification !== notification && p.notification !== '*') return -1
  if (p.channel !== channel && p.channel !== '*') return -1
  return (nMatch ? 2 : 0) + (cMatch ? 1 : 0)
}

export class NotificationPreferences {
  constructor(private readonly store: PreferenceStore) {}

  /** Silence a notification/channel (defaults to all: `{ }` mutes everything). */
  optOut(userId: string, target: { notification?: string; channel?: string } = {}): Promise<void> {
    return this.store.set({ userId, notification: target.notification ?? '*', channel: target.channel ?? '*', enabled: false })
  }
  /** Re-enable a notification/channel. */
  optIn(userId: string, target: { notification?: string; channel?: string } = {}): Promise<void> {
    return this.store.set({ userId, notification: target.notification ?? '*', channel: target.channel ?? '*', enabled: true })
  }
  list(userId: string): Promise<NotificationPreference[]> {
    return this.store.list(userId)
  }

  /** Whether a (notification, channel) may be sent to a user — the most specific preference decides; default allowed. */
  async allowed(userId: string, notification: string, channel: string): Promise<boolean> {
    let best: { rank: number; enabled: boolean } | undefined
    for (const pref of await this.store.list(userId)) {
      const rank = specificity(pref, notification, channel)
      if (rank < 0) continue
      if (!best || rank > best.rank) best = { rank, enabled: pref.enabled }
    }
    return best ? best.enabled : true
  }
}
