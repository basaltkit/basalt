import { definePlugin, ensureMetadata } from '@machize/core'
import type { CommandDefinition } from './command.js'

/** Registers app-defined commands into the 'commands' metadata bucket. */
export function commandsPlugin(commands: CommandDefinition[]) {
  return definePlugin({
    name: 'machize:commands',
    register({ container }) {
      const metadata = ensureMetadata(container)
      for (const command of commands) metadata.add('commands', command)
    },
  })
}
