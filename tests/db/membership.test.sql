-- What my_account() says about membership: Stripe, Tom's grant, and bans.
begin;

insert into auth.users (id, email) values ('c0000000-0000-4000-8000-000000000001', 'm@example.com');

create function pg_temp.me() returns record language sql as $$
  select (is_member, member_until, reason, banned, check_failed) from public.my_account()
$$;

create function pg_temp.check_as_user(expect_member boolean, expect_reason text, label text) returns void
language plpgsql as $$
declare
  r record;
begin
  perform set_config('request.jwt.claims', '{"sub": "c0000000-0000-4000-8000-000000000001"}', true);
  select * into r from public.my_account();
  assert r.is_member is not distinct from expect_member, label || ': is_member = ' || coalesce(r.is_member::text, 'null');
  assert r.reason is not distinct from expect_reason, label || ': reason = ' || coalesce(r.reason, 'null');
end $$;

-- Free: nothing set.
select pg_temp.check_as_user(false, null, 'free by default');

-- Stripe says member until next week.
update public.entitlements set stripe_until = now() + interval '7 days', reason = 'subscription', status = 'active'
  where user_id = 'c0000000-0000-4000-8000-000000000001';
select pg_temp.check_as_user(true, 'subscription', 'stripe ahead');

-- Stripe's time has passed.
update public.entitlements set stripe_until = now() - interval '1 second'
  where user_id = 'c0000000-0000-4000-8000-000000000001';
select pg_temp.check_as_user(false, 'subscription', 'stripe passed');

-- Tom's grant on its own.
update public.entitlements set stripe_until = null, reason = null, manual_grant_until = now() + interval '30 days'
  where user_id = 'c0000000-0000-4000-8000-000000000001';
select pg_temp.check_as_user(true, 'grant', 'grant only');

-- Both: the later one is the reason, and member_until is the later time.
update public.entitlements set stripe_until = now() + interval '60 days', reason = 'trial'
  where user_id = 'c0000000-0000-4000-8000-000000000001';
select pg_temp.check_as_user(true, 'trial', 'stripe later than grant');
do $$ begin
  perform set_config('request.jwt.claims', '{"sub": "c0000000-0000-4000-8000-000000000001"}', true);
  assert (select member_until from public.my_account()) =
         (select stripe_until from public.entitlements where user_id = 'c0000000-0000-4000-8000-000000000001'),
         'member_until is the later of the two';
end $$;

-- An expired grant doesn't count.
update public.entitlements set stripe_until = null, reason = null, manual_grant_until = now() - interval '1 day'
  where user_id = 'c0000000-0000-4000-8000-000000000001';
select pg_temp.check_as_user(false, null, 'grant expired');

-- Banned beats everything.
update public.entitlements set banned = true, manual_grant_until = now() + interval '1 year',
                               stripe_until = now() + interval '1 year', reason = 'subscription'
  where user_id = 'c0000000-0000-4000-8000-000000000001';
select pg_temp.check_as_user(false, 'grant', 'banned');
do $$ begin
  perform set_config('request.jwt.claims', '{"sub": "c0000000-0000-4000-8000-000000000001"}', true);
  assert (select banned from public.my_account()), 'banned is shown';
end $$;

-- A failed Stripe check is flagged, without showing the error text.
update public.entitlements set banned = false, check_error = 'Stripe timed out'
  where user_id = 'c0000000-0000-4000-8000-000000000001';
do $$ begin
  perform set_config('request.jwt.claims', '{"sub": "c0000000-0000-4000-8000-000000000001"}', true);
  assert (select check_failed from public.my_account()), 'check_failed is true';
end $$;

rollback;
