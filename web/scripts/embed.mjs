// Copies the built frontend (web/dist) into the Go server's embed directory,
// replacing whatever was there except the tracked .gitkeep placeholder.
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const target = fileURLToPath(new URL('../../server/internal/webdist/dist/', import.meta.url))

if (!existsSync(`${dist}index.html`)) {
  console.error('web/dist/index.html is missing. Run the build first.')
  process.exit(1)
}
for (const name of readdirSync(target)) {
  if (name !== '.gitkeep') rmSync(`${target}${name}`, { recursive: true, force: true })
}
cpSync(dist, target, { recursive: true })
console.log(`Copied web/dist into server/internal/webdist/dist`)
