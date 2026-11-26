// `orca plugin check` renders the panel once per scenario with the worker on a fresh host, and
// `orca plugin shot . --scenario <name>` captures one. The scenarios are in src/panel/checks.ts:
// core's own, merged with the ones each piece keeps in its folder.
import { defineCheck } from 'orca/testing'
import { CHECKS } from './checks'

export default defineCheck(CHECKS)
