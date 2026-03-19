// supabase/functions/delete-account/index.ts
// Deploy: supabase functions deploy delete-account

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response(
      JSON.stringify({ error: 'Missing authorization header' }),
      { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )

    // Validate caller JWT
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )
    const { data: { user }, error: authErr } = await userClient.auth.getUser()
    if (authErr || !user) return new Response(
      JSON.stringify({ error: 'Invalid or expired token' }),
      { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )

    // Service-role client for privileged operations
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // Delete user data — ON DELETE CASCADE handles most of it,
    // but explicit order avoids FK constraint errors
    for (const table of ['trade_images','trades','journal_settings','journals','profiles']) {
      const { error } = await admin.from(table).delete().eq('user_id', user.id)
      if (error) console.error(`delete ${table}:`, error.message)
    }

    // Delete auth user last
    const { error: delErr } = await admin.auth.admin.deleteUser(user.id)
    if (delErr) return new Response(
      JSON.stringify({ error: delErr.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )

    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }
})