import { METADATA } from '@machize/core'
import { defineCommand, type CommandDefinition } from './command.js'

/** Route entries written by HTTP adapters into the 'http:routes' bucket. */
export interface RouteMetadata {
  method: string
  url: string
  [key: string]: unknown
}

/** Schedule entries written by the scheduler into the 'schedule:entries' bucket. */
export interface ScheduleMetadata {
  name: string
  cron: string
  timezone: string
}

export const routesCommand = defineCommand({
  name: 'routes',
  description: 'List the HTTP routes registered by the app',
  handle({ container, io }) {
    const routes = container.has(METADATA)
      ? container.get(METADATA).get<RouteMetadata>('http:routes')
      : []
    if (routes.length === 0) {
      io.log('No routes registered.')
      return
    }
    io.table(routes.map(({ method, url }) => ({ method, url })))
  },
})

export const scheduleListCommand = defineCommand({
  name: 'schedule:list',
  description: 'List scheduled tasks and their cron expressions',
  handle({ container, io }) {
    const entries = container.has(METADATA)
      ? container.get(METADATA).get<ScheduleMetadata>('schedule:entries')
      : []
    if (entries.length === 0) {
      io.log('No scheduled tasks.')
      return
    }
    io.table(entries.map(({ name, cron, timezone }) => ({ name, cron, timezone })))
  },
})

export function builtinCommands(): CommandDefinition[] {
  return [routesCommand, scheduleListCommand]
}
