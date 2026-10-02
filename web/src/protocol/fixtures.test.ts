// The TypeScript half of the protocol contract (spec section 6.4). The Go
// tests round-trip the same files through the Go structs.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { clientMessage, clientTypes, serverMessage, serverTypes } from './schemas'

const fixturesDir = fileURLToPath(new URL('../../../protocol-fixtures', import.meta.url))

const suites = [
  { dir: 'client', schema: clientMessage, types: clientTypes },
  { dir: 'server', schema: serverMessage, types: serverTypes },
]

for (const { dir, schema, types } of suites) {
  describe(`${dir} fixtures`, () => {
    const files = readdirSync(join(fixturesDir, dir)).filter((f) => f.endsWith('.json'))

    it.each(files)('%s parses without losing a field', (file) => {
      const raw: unknown = JSON.parse(readFileSync(join(fixturesDir, dir, file), 'utf8'))
      const parsed = schema.parse(raw)
      expect(parsed.type).toBe(file.replace(/\.json$/, ''))
      // zod drops keys it doesn't know, so equality means the schema knows
      // every field the Go side sends.
      expect(parsed).toStrictEqual(raw)
    })

    it('has exactly one fixture per message type', () => {
      const fixtureTypes = files.map((f) => f.replace(/\.json$/, '')).sort()
      expect(fixtureTypes).toEqual([...types].sort())
    })
  })
}
