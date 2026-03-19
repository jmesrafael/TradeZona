-- migration_stripe.sql
-- ================================================================
--  Add stripe_customer_id column to profiles table
--  Run in: Supabase Dashboard → SQL Editor → New Query → RUN
-- ================================================================

alter table public.profiles
  add column if not exists stripe_customer_id text unique;

comment on column public.profiles.stripe_customer_id
  is 'Stripe Customer ID — set by stripe-webhook on first successful checkout';

-- Index for fast lookups during webhook processing
create index if not exists idx_profiles_stripe_customer_id
  on public.profiles (stripe_customer_id);
