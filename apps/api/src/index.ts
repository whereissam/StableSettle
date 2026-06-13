import { app } from './app'
import { initDb } from './db'

const PORT = Number(process.env.PORT ?? 8787)

await initDb()
console.log(`StableSettle API listening on http://localhost:${PORT}`)

export default {
  port: PORT,
  fetch: app.fetch,
}
