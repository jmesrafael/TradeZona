// supabase/functions/billing-portal/index.ts
// Deploy: supabase functions deploy billing-portal
//
// Required secrets (already set):
//   STRIPE_SECRET_KEY  — Stripe secret key
//   APP_URL            — your Vercel URL

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14?target=deno'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    // 1. Authenticate caller
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response(
      JSON.stringify({ error: 'Missing authorization header' }),
      { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )

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

    // 2. Look up the Stripe customer ID from the profile
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const { data: profile } = await admin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single()

    if (!profile?.stripe_customer_id) return new Response(
      JSON.stringify({ error: 'No billing account found. Please subscribe first.' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )

    // 3. Create billing portal session
    const appUrl = Deno.env.get('APP_URL') ?? 'https://tradezona.vercel.app'
    let returnUrl: string
    try { returnUrl = (await req.json()).return_url ?? `${appUrl}/subscription` }
    catch (_) { returnUrl = `${appUrl}/subscription` }

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
      apiVersion: '2023-10-16',
    })

    const portalSession = await stripe.billingPortal.sessions.create({
      customer:   profile.stripe_customer_id,
      return_url: returnUrl,
    })

    return new Response(JSON.stringify({ url: portalSession.url }), {
      status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }
    })

  } catch (err: any) {
    console.error('billing-portal error:', err)
    return new Response(JSON.stringify({ error: err.message ?? 'Internal server error' }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }
})