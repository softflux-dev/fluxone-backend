import dotenv from 'dotenv'
import { pool, testConnection } from './src/config/db.js'
import { app } from './src/app.js'
import { runMigrations } from './database/migrate.js'

dotenv.config()
const port = Number(process.env.PORT || 5000)

async function startServer() {
  try {
    await testConnection()
    await runMigrations()
    const server = app.listen(port, () => {
      console.log(`FluxOne inventory API listening on port ${port}`)
    })
    async function shutdown() {
      server.close()
      await pool.end()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  } catch (error) {
    console.error('FATAL: Database connection failed. Shutting down.')
    console.error(error.message)
    process.exit(1)
  }
}

startServer()
