-- Who can read and write what. The browser (anon before login, authenticated
-- after) may only call my_account(), and only ever sees its own account.
begin;

insert into auth.users (id, email) values
  ('b0000000-0000-4000-8000-00000000000a', 'alice@example.com'),
  ('b0000000-0000-4000-8000-00000000000b', 'bob@example.com');
update public.entitlements set stripe_until = now() + interval '10 days', reason = 'subscription', status = 'active'
  where user_id = 'b0000000-0000-4000-8000-00000000000b';

-- Not logged in.
set local role anon;
do $$
declare
  t text;
begin
  foreach t in array array['accounts', 'stripe_customers', 'subscriptions', 'entitlements'] loop
    begin
      execute format('select 1 from public.%I limit 1', t);
      raise exception 'anon could read %', t;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform * from public.my_account();
    raise exception 'anon could call my_account()';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Logged in as Alice.
select set_config('request.jwt.claims', '{"sub": "b0000000-0000-4000-8000-00000000000a", "role": "authenticated"}', true);
set local role authenticated;
do $$
declare
  t text;
  n int;
begin
  foreach t in array array['accounts', 'stripe_customers', 'subscriptions', 'entitlements'] loop
    begin
      execute format('select 1 from public.%I limit 1', t);
      raise exception 'authenticated could read %', t;
    exception when insufficient_privilege then null;
    end;
  end loop;
  -- Making herself a member.
  begin
    update public.entitlements set manual_grant_until = now() + interval '1 year';
    raise exception 'authenticated could update entitlements';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.stripe_customers (customer_id, user_id) values ('cus_Steal', 'b0000000-0000-4000-8000-00000000000a');
    raise exception 'authenticated could link a customer';
  exception when insufficient_privilege then null;
  end;
  -- The internal functions are out of reach.
  begin
    perform private.handle_new_user();
    raise exception 'authenticated could reach the private schema';
  exception when insufficient_privilege then null;
  end;
  -- my_account(): exactly her own row.
  select count(*) into n from public.my_account();
  assert n = 1, 'my_account() returns one row';
  assert (select email from public.my_account()) = 'alice@example.com', 'it is her own';
  assert (select not is_member from public.my_account()), 'Alice is free';
end $$;
reset role;

-- Logged in as Bob, who is a member: sees his own, not Alice's.
select set_config('request.jwt.claims', '{"sub": "b0000000-0000-4000-8000-00000000000b", "role": "authenticated"}', true);
set local role authenticated;
do $$ begin
  assert (select email from public.my_account()) = 'bob@example.com', 'Bob sees his own account';
  assert (select is_member from public.my_account()), 'Bob is a member';
end $$;
reset role;

-- A token with no user in it sees nothing.
select set_config('request.jwt.claims', '{"role": "authenticated"}', true);
set local role authenticated;
do $$ begin
  assert (select count(*) from public.my_account()) = 0, 'no sub claim: no rows';
end $$;
reset role;

-- The service role (server side) can read everything.
set local role service_role;
do $$ begin
  assert (select count(*) from public.accounts where email in ('alice@example.com', 'bob@example.com')) = 2,
         'service role reads all accounts';
end $$;
reset role;

rollback;
