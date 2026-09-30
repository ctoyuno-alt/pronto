import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

// Bypasses RLS — use only server-side for trusted operations
export function createServiceClient() {
  const supabaseUrl = process.env.INTERNAL_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!
  return createSupabaseClient<Database>(
    supabaseUrl,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      global: {
        fetch: (url, options = {}) => fetch(url, { ...options, cache: 'no-store' }),
      },
    }
  )
}
