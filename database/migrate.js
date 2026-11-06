import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { pool, query } from '../src/config/db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.join(__dirname, 'migrations')

async function ensureMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
}

export async function runMigrations() {
  await ensureMigrationsTable()

  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()

  const { rows: applied } = await query(`SELECT filename FROM schema_migrations`)
  const done = new Set(applied.map((row) => row.filename))

  // Bootstrap: if migrations already applied manually / via old runner, mark
  // prior files as done when their effects are present (avoid re-running 001–011).
  if (!done.size) {
    const { rows: productsCols } = await query(`
      SELECT 1 AS ok
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'branch_id'
      LIMIT 1
    `)
    const { rows: ledgerExists } = await query(`
      SELECT 1 AS ok
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'inventory_ledger'
      LIMIT 1
    `)

    if (ledgerExists[0]) {
      for (const file of files) {
        if (file === '012_branch_scoped_inventory.sql') {
          if (productsCols[0]) {
            await query(`INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, [
              file,
            ])
            done.add(file)
          }
          continue
        }
        // 001–011 already reflected in this live DB
        await query(`INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, [file])
        done.add(file)
      }
      console.log('Bootstrapped schema_migrations for existing database')
    }
  }

  let ran = 0
  for (const file of files) {
    if (done.has(file)) {
      // console.log(`Skip ${file} (already applied)`)
      continue
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    // console.log(`Running ${file}`)
    await query(sql)
    await query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file])
    ran += 1
  }

  console.log(ran ? `Migrations complete (${ran} new)` : 'Migrations complete (nothing pending)')
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isCli) {
  runMigrations()
    .catch(async (error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(async () => {
      await pool.end()
    })
}
