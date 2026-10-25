#!/usr/bin/env node
import { runLauncher } from './launcher.js'

process.exitCode = await runLauncher(process.argv.slice(2))
