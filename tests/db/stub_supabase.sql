-- Just enough of Supabase for the migrations and tests to run on a plain Postgres
-- (tools/test_db.py). Never apply this to a real Supabase project: it already
-- has all of this, the real way.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;
create table auth.users (
  id         uuid primary key default gen_random_uuid(),
  email              text,
  phone              text,
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  created_at         timestamptz not null default now()
);

-- As in Supabase: the user ID from the JWT the API was called with.
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                         nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid
$$;
-- As in Supabase: all the claims of that JWT.
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
grant usage on schema auth to anon, authenticated, service_role;

-- Supabase's defaults for the public schema: every new table and function is
-- granted to the API roles. The migrations must take that away themselves.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
