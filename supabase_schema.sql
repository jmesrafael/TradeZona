-- supabase_schema.sql
-- ================================================================
--  TradeZona — Complete Supabase SQL Schema
--  Paste this ENTIRE file into:
--    Supabase Dashboard → SQL Editor → New Query → RUN
-- ================================================================

-- ── Extensions ──────────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ================================================================
--  TABLE: profiles
--  Auto-created when a user signs up via Supabase Auth trigger.
-- ================================================================
create table if not exists public.profiles (
  id          uuid references auth.users(id) on delete cascade primary key,
  name        text,
  plan        text not null default 'free',   -- 'free' | 'pro'
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.profiles is 'One row per registered user. Mirrors auth.users.';

-- ================================================================
--  TABLE: journals
--  Each user can create multiple journals (one per account/strategy)
-- ================================================================
create table if not exists public.journals (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid references public.profiles(id) on delete cascade not null,
  name          text not null,
  capital       numeric,
  pin_hash      text,           -- SHA-256 hex hash of journal PIN
  show_pnl      boolean not null default true,
  show_capital  boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.journals is 'Trading journals owned by a user.';

-- ================================================================
--  TABLE: trades
--  Core trade log. Each row is one trade entry.
-- ================================================================
create table if not exists public.trades (
  id            uuid primary key default uuid_generate_v4(),
  journal_id    uuid references public.journals(id) on delete cascade not null,
  user_id       uuid references public.profiles(id) on delete cascade not null,
  trade_date    date,
  trade_time    time,
  pair          text,
  position      text,           -- 'Long' | 'Short'
  strategy      text[]  not null default '{}',
  timeframe     text[]  not null default '{}',
  pnl           numeric,
  r_factor      numeric,
  confidence    smallint check (confidence between 1 and 5),
  mood          text[]  not null default '{}',
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.trades is 'Individual trade records belonging to a journal.';

-- ================================================================
--  TABLE: trade_images
--  Images (chart screenshots) attached to trades.
--  Stored as base64 in the `data` column.
-- ================================================================
create table if not exists public.trade_images (
  id          uuid primary key default uuid_generate_v4(),
  trade_id    uuid references public.trades(id) on delete cascade not null,
  user_id     uuid references public.profiles(id) on delete cascade not null,
  data        text,             -- base64 encoded image data
  storage_url text,             -- optional: Supabase Storage URL for large images
  created_at  timestamptz not null default now()
);
comment on table public.trade_images is 'Chart screenshots attached to trades.';

-- ================================================================
--  TABLE: journal_settings
--  Per-journal tag lists and mood colours.
--  One row per journal (1-to-1 relationship).
-- ================================================================
create table if not exists public.journal_settings (
  id            uuid primary key default uuid_generate_v4(),
  journal_id    uuid references public.journals(id) on delete cascade not null unique,
  user_id       uuid references public.profiles(id) on delete cascade not null,
  strategies    text[]  not null default '{}',
  timeframes    text[]  not null default '{}',
  pairs         text[]  not null default '{}',
  moods         text[]  not null default '{}',
  mood_colors   jsonb   not null default '{}',
  updated_at    timestamptz not null default now()
);
comment on table public.journal_settings is 'Tag lists and mood colours for a journal.';

-- ================================================================
--  ROW LEVEL SECURITY (RLS)
--  Users can only read/write their OWN rows.
-- ================================================================

alter table public.profiles         enable row level security;
alter table public.journals         enable row level security;
alter table public.trades           enable row level security;
alter table public.trade_images     enable row level security;
alter table public.journal_settings enable row level security;

-- Drop existing policies if re-running this script
drop policy if exists "profiles_select"  on public.profiles;
drop policy if exists "profiles_update"  on public.profiles;
drop policy if exists "journals_all"     on public.journals;
drop policy if exists "trades_all"       on public.trades;
drop policy if exists "images_all"       on public.trade_images;
drop policy if exists "settings_all"     on public.journal_settings;

-- profiles
create policy "profiles_select" on public.profiles
  for select using (auth.uid() = id);

create policy "profiles_update" on public.profiles
  for update using (auth.uid() = id);

-- journals
create policy "journals_all" on public.journals
  for all using (auth.uid() = user_id);

-- trades
create policy "trades_all" on public.trades
  for all using (auth.uid() = user_id);

-- trade_images
create policy "images_all" on public.trade_images
  for all using (auth.uid() = user_id);

-- journal_settings
create policy "settings_all" on public.journal_settings
  for all using (auth.uid() = user_id);

-- ================================================================
--  TRIGGER: auto-create profile row on new signup
--  Fires after a row is inserted into auth.users.
-- ================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, plan)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'name',
      split_part(new.email, '@', 1)
    ),
    coalesce(new.raw_user_meta_data->>'plan', 'free')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute procedure public.handle_new_user();

-- ================================================================
--  TRIGGER: keep updated_at current automatically
-- ================================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at       on public.profiles;
drop trigger if exists trg_journals_updated_at        on public.journals;
drop trigger if exists trg_trades_updated_at          on public.trades;
drop trigger if exists trg_journal_settings_updated_at on public.journal_settings;

create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();

create trigger trg_journals_updated_at
  before update on public.journals
  for each row execute procedure public.set_updated_at();

create trigger trg_trades_updated_at
  before update on public.trades
  for each row execute procedure public.set_updated_at();

create trigger trg_journal_settings_updated_at
  before update on public.journal_settings
  for each row execute procedure public.set_updated_at();

-- ================================================================
--  INDEXES for query performance
-- ================================================================
create index if not exists idx_journals_user_id
  on public.journals (user_id);

create index if not exists idx_trades_journal_id
  on public.trades (journal_id);

create index if not exists idx_trades_user_id
  on public.trades (user_id);

create index if not exists idx_trades_trade_date
  on public.trades (trade_date);

create index if not exists idx_trade_images_trade_id
  on public.trade_images (trade_id);

create index if not exists idx_trade_images_user_id
  on public.trade_images (user_id);

create index if not exists idx_journal_settings_journal_id
  on public.journal_settings (journal_id);

-- ================================================================
--  REALTIME: enable realtime for trades table
-- ================================================================
begin;
  drop publication if exists supabase_realtime;
  create publication supabase_realtime for table
    public.trades,
    public.trade_images,
    public.journals;
commit;

-- ================================================================
--  DONE
--  You should see: "Success. No rows returned"
-- ================================================================
