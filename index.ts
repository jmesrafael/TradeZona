// supabase/functions/delete-account/index.ts
// ============================================================
//  TradeZona — Delete Account Edge Function
//  Deploy: supabase functions deploy delete-account
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Authenticate the calling user
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // User-scoped client (validates JWT)
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: userError } = await userClient.auth.getUser()
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const userId = user.id

    // 2. Service role client for privileged operations
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // 3. Delete Storage images
    // Find all trade_images with storage_path for this user
    const { data: images } = await adminClient
      .from('trade_images')
      .select('storage_path')
      .eq('user_id', userId)
      .not('storage_path', 'is', null)

    if (images && images.length > 0) {
      const paths = images.map((i: any) => i.storage_path).filter(Boolean)
      if (paths.length > 0) {
        const { error: storageError } = await adminClient
          .storage
          .from('trade-images')
          .remove(paths)
        if (storageError) {
          console.error('Storage cleanup error (non-fatal):', storageError)
        }
      }
    }

    // 4. Delete DB rows in dependency order
    // trade_images → trades → journal_settings → journals → profiles
    const tables = ['trade_images', 'trades', 'journal_settings', 'journals', 'profiles']
    for (const table of tables) {
      const { error } = await adminClient
        .from(table)
        .delete()
        .eq('user_id', userId)
      if (error) {
        console.error(`Error deleting from ${table}:`, error)
        // Continue — partial cleanup is better than no cleanup
      }
    }

    // 5. Delete the auth user (must be last)
    const { error: deleteAuthError } = await adminClient.auth.admin.deleteUser(userId)
    if (deleteAuthError) {
      console.error('Auth user deletion error:', deleteAuthError)
      return new Response(JSON.stringify({ error: 'Failed to delete auth user: ' + deleteAuthError.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ success: true, message: 'Account permanently deleted.' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error('Unexpected error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
