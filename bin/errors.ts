#!/usr/bin/env node
// The error diff as a command line, for a bot's morning report. Runs under plain Node 22.18 or
// later, with no build: `node bin/errors.ts --help`. Everything is in src/pieces/errors/cli.ts.
import { main } from '../src/pieces/errors/cli.ts'

process.exitCode = await main(process.argv.slice(2))
