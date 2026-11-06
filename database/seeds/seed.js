import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import bcrypt from 'bcryptjs'
import { BCRYPT_COST } from '../../src/config/constants.js'
import { pool, query } from '../../src/config/db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function seed() {
  const passwordHash = await bcrypt.hash('password', BCRYPT_COST)
  const admin123Hash = await bcrypt.hash('admin123', BCRYPT_COST)
  const sql = fs
    .readFileSync(path.join(__dirname, 'dummy_data.sql'), 'utf8')
    .replaceAll('{{PASSWORD_HASH}}', passwordHash)
    .replaceAll('{{ADMIN123_HASH}}', admin123Hash)

  await query(sql)
  await pool.end()

  console.log('Seed complete.')
  // Demo credential dump — commented out for production.
  // console.log('')
  // console.log('SoftwareFlux (upward flow B2B Admin)')
  // console.log('  softwareflux@company.com        [b2b_admin]  password: admin123')
  // console.log('')
  // console.log('Demo tenants (password for all: password)')
  // console.log('')
  // console.log('Company A  (tenantSlug: company-a)')
  // console.log('  admin@companya.local            [b2b_admin]')
  // console.log('  branch.wah@companya.local       [branch_manager]  Wah Cantt')
  // console.log('  branch.haripur@companya.local   [branch_manager]  Haripur')
  // console.log('')
  // console.log('Company B  (tenantSlug: company-b)')
  // console.log('  admin@companyb.local            [b2b_admin]')
  // console.log('  branch@companyb.local           [branch_manager]  Taxilla')
  // console.log('')
  // console.log('Inventory Managers / Cashiers: create via Branch Manager Staff Management')
}

seed().catch(async (error) => {
  console.error(error)
  await pool.end()
  process.exit(1)
})
