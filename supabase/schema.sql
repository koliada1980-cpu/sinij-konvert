-- Схема сервиса «Синий конверт».
-- Таблицы доступны только Edge Function через service role.
create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

create table if not exists public.agent_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default 'Николай Калиберда',
  agency text not null default 'Самолет Плюс',
  city text not null default 'Санкт-Петербург',
  currency text not null default '₽',
  reward numeric(12,2) not null default 10000,
  payout_details text not null default '',
  greeting text not null default 'Спасибо, что рекомендуете меня! Каждый ваш контакт — на вес золота',
  invite_text text not null default 'Привет! Если вам или знакомым нужна помощь с недвижимостью в Санкт-Петербурге, рекомендую Николая Калиберду из Самолет Плюс.',
  invite_slug text not null unique default 'nikolay-kaliberda',
  formats jsonb not null default '{"money":true,"symbolic":false,"discount":false,"gift":false}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.referrers (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agent_profiles(id) on delete cascade,
  display_name text not null default 'Клиент',
  token_hash text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agent_profiles(id) on delete cascade,
  referrer_id uuid not null references public.referrers(id) on delete cascade,
  name text not null,
  contact text not null,
  need text not null check (need in ('Купить','Продать','Аренда')),
  comment text not null default '',
  status smallint not null default 0 check (status between 0 and 5),
  created_at timestamptz not null default now()
);

create table if not exists public.envelopes (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agent_profiles(id) on delete cascade,
  referrer_id uuid not null references public.referrers(id) on delete cascade,
  lead_id uuid not null unique references public.leads(id) on delete cascade,
  format text not null,
  amount text not null,
  message text not null,
  payout_details text not null default '',
  opened_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists leads_agent_created_idx on public.leads (agent_id, created_at desc);
create index if not exists leads_referrer_created_idx on public.leads (referrer_id, created_at desc);
create index if not exists envelopes_referrer_created_idx on public.envelopes (referrer_id, created_at desc);

alter table public.agent_profiles enable row level security;
alter table public.referrers enable row level security;
alter table public.leads enable row level security;
alter table public.envelopes enable row level security;
revoke all on public.agent_profiles, public.referrers, public.leads, public.envelopes from anon, authenticated;
grant select, insert, update, delete on public.agent_profiles, public.referrers, public.leads, public.envelopes to service_role;

create or replace function app_private.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  chosen_slug text := 'nikolay-kaliberda';
begin
  if exists (select 1 from public.agent_profiles where invite_slug = chosen_slug) then
    chosen_slug := chosen_slug || '-' || left(replace(new.id::text, '-', ''), 6);
  end if;
  insert into public.agent_profiles (id, invite_slug)
  values (new.id, chosen_slug)
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function app_private.handle_new_auth_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_created_agent_profile on auth.users;
create trigger on_auth_user_created_agent_profile
  after insert on auth.users
  for each row execute function app_private.handle_new_auth_user();

