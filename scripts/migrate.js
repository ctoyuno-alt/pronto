/**
 * Pronto — automatic database migration runner
 *
 * Reads SQL files from supabase/migrations/ in order and applies any that
 * haven't been applied yet.  Applied migrations are tracked in the
 * `schema_migrations` table inside the same Postgres database.
 *
 * Required env var: DATABASE_URL
 * Optional:         NEXT_PUBLIC_APP_URL, CRON_SECRET  (substituted in SQL)
 *
 * Exit codes: 0 = success, 1 = fatal error
 */

'use strict'

const { Client } = require('pg')
const fs       = require('fs')
const path     = require('path')

// ── Configuration ────────────────────────────────────────────────────────────

const DATABASE_URL   = process.env.DATABASE_URL
const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations')

// Migrations that depend on optional Supabase extensions.
// If they fail with a "schema not found" or "function not found" error
// they are skipped with a warning instead of aborting the whole run.
const OPTIONAL_MIGRATIONS = new Set([
  '007_cron_jobs.sql',   // requires pg_cron + pg_net (Database → Extensions)
])

// ── Env-var substitution in SQL ──────────────────────────────────────────────
// Any ${VARIABLE_NAME} placeholder in a .sql file is replaced with the
// corresponding process.env value before execution.
function interpolate(sql) {
  return sql.replace(/\$\{([A-Z0-9_]+)\}/g, (match, key) => {
    const val = process.env[key]
    if (!val) {
      console.warn(`  ⚠  env var ${key} is not set — placeholder left as-is`)
      return match
    }
    return val
  })
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set.')
    console.error('Add it to your .env file:')
    console.error('  Supabase Dashboard → Project Settings → Database → Connection string (URI, Session mode)')
    process.exit(1)
  }

  // MIGRATE_SSL=false is an explicit opt-out for DBs that don't speak TLS at all
  // (e.g. a local Supabase CLI stack) — every real Supabase project (yours
  // included) requires SSL, so this must stay an explicit flag, never inferred
  // from the host in DATABASE_URL.
  //
  // certs/supabase-ca.crt is Supabase's public root CA (same file for every
  // Supabase project — download your own copy at Dashboard → Project Settings
  // → Database → SSL Configuration if you ever need to regenerate it). With it,
  // rejectUnauthorized:true actually verifies the server cert chain instead of
  // just encrypting blindly — Supabase's direct-connection Postgres cert isn't
  // in Node's default CA trust store, so a plain true/false toggle isn't enough;
  // the ca option is required.
  const sslDisabled = process.env.MIGRATE_SSL === 'false'
  const CA_CERT_PATH = path.join(__dirname, '..', 'certs', 'supabase-ca.crt')
  const clientOptions = {
    connectionString: DATABASE_URL,
    ssl: sslDisabled
      ? false
      : { rejectUnauthorized: true, ca: fs.readFileSync(CA_CERT_PATH, 'utf8') },
  }

  // Retry connection — free-tier Supabase can temporarily reject if connection
  // slots are exhausted from a previous crashed run. A pg.Client can only ever
  // connect once — reusing the same instance across attempts made every retry
  // after the first fail with "Client has already been connected. You cannot
  // reuse a client.", masking whatever the real connection error was. A fresh
  // Client per attempt is required.
  let pool
  let lastErr
  for (let attempt = 1; attempt <= 5; attempt++) {
    pool = new Client(clientOptions)
    try {
      await pool.connect()
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      console.log(`  Connection attempt ${attempt}/5 failed: ${err.message}`)
      await pool.end().catch(() => {})
      if (attempt < 5) {
        console.log(`  Retrying in 5 s…`)
        await new Promise(r => setTimeout(r, 5000))
      }
    }
  }
  if (lastErr) throw lastErr

  try {
    // Ensure the tracking table exists and is not exposed via PostgREST
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_schema_migrations (
        filename   TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`ALTER TABLE app_schema_migrations ENABLE ROW LEVEL SECURITY`)

    // Fetch already-applied migrations
    const { rows } = await pool.query('SELECT filename FROM app_schema_migrations ORDER BY filename')
    const applied   = new Set(rows.map(r => r.filename))

    // Read migration files sorted by name (001 → 018 …)
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort()

    const pending = files.filter(f => !applied.has(f))

    if (pending.length === 0) {
      console.log('✓ All migrations already applied — nothing to do.')
      return
    }

    console.log(`Found ${pending.length} pending migration(s):`)

    let failed = 0

    for (const file of pending) {
      process.stdout.write(`  → ${file} … `)

      const filePath = path.join(MIGRATIONS_DIR, file)
      const rawSql   = fs.readFileSync(filePath, 'utf8')
      const sql      = interpolate(rawSql)

      try {
        await pool.query(sql)
        await pool.query(
          'INSERT INTO app_schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
          [file],
        )
        console.log('done')
      } catch (err) {
        const msg = err.message || ''

        if (OPTIONAL_MIGRATIONS.has(file) &&
            (msg.includes('schema "cron" does not exist') ||
             msg.includes('function cron.') ||
             msg.includes('schema "net" does not exist') ||
             msg.includes('function net.'))) {
          console.log(`skipped (optional — enable pg_cron / pg_net in Supabase Dashboard → Database → Extensions)`)
        } else if (msg.includes('already exists')) {
          // Migration was previously applied manually — record it and continue
          await pool.query(
            'INSERT INTO app_schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
            [file],
          )
          console.log('skipped (already applied)')
        } else {
          console.log('FAILED')
          console.error(`     Error: ${msg}`)
          failed++
        }
      }
    }

    if (failed > 0) {
      console.error(`\n${failed} migration(s) failed.  Fix the errors above and re-run.`)
      process.exit(1)
    }

    console.log('\n✓ Migrations complete.')
  } finally {
    await pool.end().catch(() => {})
  }
}

main().catch(err => {
  console.error('Unexpected error:', err.message)
  process.exit(1)
})
