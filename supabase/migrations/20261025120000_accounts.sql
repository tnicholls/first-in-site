-- Accounts and the free-or-member check for the First In web app (2026-10-25).
--
-- Anyone can log in with an email code (Supabase Auth), and a new account starts
-- free. An account is a member while it isn't banned and either Tom's manual
-- grant or the time worked out from Stripe (stripe_until) is still ahead.
--
-- The browser only ever reads through my_account(): it has no rights on the
-- tables. Writes come from the entitlement functions (a direct database
-- connection) and from Tom in the dashboard (manual_grant_until, banned).

-- Internal functions live here, out of the API's reach (only public is exposed).
create schema private;
revoke all on schema private from public;

create table public.accounts (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null unique check (email <> '' and email = lower(btrim(email))),
  created_at timestamptz not null default now()
);

-- The Stripe customers found for an account by its email. A customer belongs to
-- one account at most, and stays linked if its email later changes in Stripe.
create table public.stripe_customers (
  customer_id text primary key check (customer_id like 'cus\_%'),
  user_id     uuid not null references public.accounts (user_id) on delete cascade,
  email       text,                 -- Stripe's copy, lowercased, for Tom
  linked_at   timestamptz not null default now()
);
create index stripe_customers_user_id on public.stripe_customers (user_id);

-- Each linked customer's subscriptions as Stripe last reported them.
create table public.subscriptions (
  subscription_id      text primary key check (subscription_id like 'sub\_%'),
  customer_id          text not null references public.stripe_customers (customer_id) on delete cascade,
  status               text not null,
  current_period_start timestamptz,
  current_period_end   timestamptz,
  trial_end            timestamptz,
  cancel_at            timestamptz,
  cancel_at_period_end boolean not null default false,
  -- Start of the first unpaid period while past_due, kept across later periods
  -- (the member bot's rule), so the grace can't restart every month.
  past_due_since       timestamptz,
  synced_at            timestamptz not null default now()
);
create index subscriptions_customer_id on public.subscriptions (customer_id);

create table public.entitlements (
  user_id            uuid primary key references public.accounts (user_id) on delete cascade,
  -- Tom's two fields, set in the dashboard. The functions never write them.
  manual_grant_until timestamptz,
  banned             boolean not null default false,
  -- Worked out from Stripe by the functions (supabase/functions/_shared/entitlement.ts).
  stripe_until       timestamptz,     -- member from Stripe until then; null: nothing qualifies
  reason             text check (reason in ('trial', 'subscription', 'grace', 'cancelled_in_trial')),
  status             text,            -- the Stripe status behind stripe_until
  trial_end          timestamptz,
  period_end         timestamptz,
  ends_at            timestamptz,     -- set when a cancellation is scheduled
  checked_at         timestamptz,     -- last time Stripe answered
  check_error        text,            -- last failure, cleared by the next success
  last_attempt_at    timestamptz,     -- last time the functions asked Stripe (the 30 s limit)
  updated_at         timestamptz not null default now()
);

-- No policies: with RLS on, anon and authenticated see no rows even if they get
-- rights by mistake. The service role and the postgres role bypass RLS.
alter table public.accounts enable row level security;
alter table public.stripe_customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.entitlements enable row level security;
-- Supabase grants every new public table to anon and authenticated by default.
revoke all on table public.accounts, public.stripe_customers, public.subscriptions, public.entitlements
  from anon, authenticated;

-- Every new login user gets an account and an (empty, so free) entitlement row.
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.email is null or btrim(new.email) = '' then
    return new;   -- only email logins are used; never block a sign-up over this
  end if;
  insert into public.accounts (user_id, email) values (new.id, lower(btrim(new.email)));
  insert into public.entitlements (user_id) values (new.id);
  return new;
end;
$$;

create function private.handle_user_email_change() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.email is not null and btrim(new.email) <> '' then
    update public.accounts set email = lower(btrim(new.email)) where user_id = new.id;
  end if;
  return new;
end;
$$;

-- Logins are only ever by email code. Supabase can't switch password sign-ups off,
-- and a password put on an email before its owner first logs in would still work
-- once they confirm it with their code. So a password is dropped the moment it's
-- written: code-only users have an empty one anyway, and an empty one never matches.
create function private.drop_password() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.encrypted_password := '';
  return new;
end;
$$;

-- True when the caller's session came from a password. With drop_password that
-- can't happen; this is the second lock on the same door.
create function private.signed_in_with_password() returns boolean
language sql stable set search_path = ''
as $$
  select coalesce(bool_or(m ->> 'method' = 'password'), false)
  from jsonb_array_elements(
    case when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr' else '[]'::jsonb end
  ) as m
$$;

revoke all on function private.handle_new_user(), private.handle_user_email_change(),
  private.drop_password(), private.signed_in_with_password() from public;

create trigger no_password_on_insert
  before insert on auth.users
  for each row when (new.encrypted_password is distinct from '')
  execute function private.drop_password();

create trigger no_password_on_update
  before update of encrypted_password on auth.users
  for each row when (new.encrypted_password is distinct from '')
  execute function private.drop_password();

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row when (new.email is distinct from old.email)
  execute function private.handle_user_email_change();

-- The logged-in user's own account, as the app shows it. The one thing the
-- browser may call (as supabase.rpc('my_account')).
create function public.my_account()
returns table (
  email        text,
  created_at   timestamptz,
  is_member    boolean,
  member_until timestamptz,
  reason       text,           -- trial, subscription, grace, cancelled_in_trial or grant
  status       text,
  trial_end    timestamptz,
  period_end   timestamptz,
  ends_at      timestamptz,
  banned       boolean,
  checked_at   timestamptz,
  check_failed boolean
)
language sql stable security definer set search_path = ''
as $$
  select
    a.email,
    a.created_at,
    not coalesce(e.banned, false)
      and coalesce(greatest(e.manual_grant_until, e.stripe_until) > now(), false),
    greatest(e.manual_grant_until, e.stripe_until),
    case
      when e.manual_grant_until > now()
           and e.manual_grant_until >= coalesce(e.stripe_until, '-infinity'::timestamptz) then 'grant'
      else e.reason
    end,
    e.status,
    e.trial_end,
    e.period_end,
    e.ends_at,
    coalesce(e.banned, false),
    e.checked_at,
    e.check_error is not null
  from public.accounts a
  left join public.entitlements e on e.user_id = a.user_id
  where a.user_id = (select auth.uid())
    and not private.signed_in_with_password();
$$;

-- Postgres lets PUBLIC execute every new function, and Supabase adds anon.
revoke all on function public.my_account() from public, anon;
grant execute on function public.my_account() to authenticated;

-- Logins made before this migration (if any) get their rows too.
insert into public.accounts (user_id, email)
  select id, lower(btrim(email)) from auth.users
  where email is not null and btrim(email) <> ''
  on conflict do nothing;
insert into public.entitlements (user_id)
  select user_id from public.accounts
  on conflict do nothing;
update auth.users set encrypted_password = '' where encrypted_password is distinct from '';
