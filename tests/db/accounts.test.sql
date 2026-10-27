-- Sign-up, email changes and deleting a login. Runs as the superuser, like
-- Supabase Auth's own writes to auth.users. Everything is rolled back.
begin;

-- A new login gets an account (email lowercased and trimmed) and a free entitlement.
insert into auth.users (id, email) values ('a0000000-0000-4000-8000-000000000001', '  Tom@Example.COM ');
do $$ begin
  assert (select email from public.accounts where user_id = 'a0000000-0000-4000-8000-000000000001')
         = 'tom@example.com', 'email is stored lowercased and trimmed';
  assert exists (select 1 from public.entitlements
                 where user_id = 'a0000000-0000-4000-8000-000000000001'
                   and not banned and stripe_until is null and manual_grant_until is null),
         'a new account starts free';
end $$;

-- A login without an email (never used here) doesn't block the sign-up.
insert into auth.users (id, email, phone) values ('a0000000-0000-4000-8000-000000000002', null, '+447700900000');
do $$ begin
  assert not exists (select 1 from public.accounts where user_id = 'a0000000-0000-4000-8000-000000000002'),
         'no account without an email';
end $$;

-- An email change in Auth follows through to the account.
update auth.users set email = 'New@Example.com' where id = 'a0000000-0000-4000-8000-000000000001';
do $$ begin
  assert (select email from public.accounts where user_id = 'a0000000-0000-4000-8000-000000000001')
         = 'new@example.com', 'email change is copied, lowercased';
end $$;

-- The table refuses emails that aren't lowercased and trimmed.
do $$ begin
  begin
    update public.accounts set email = 'Mixed@Example.com' where user_id = 'a0000000-0000-4000-8000-000000000001';
    raise exception 'a mixed-case email was accepted';
  exception when check_violation then null;
  end;
end $$;

-- Two logins can't share an account email.
do $$ begin
  begin
    insert into auth.users (id, email) values ('a0000000-0000-4000-8000-000000000003', 'NEW@example.com');
    raise exception 'a second account with the same email was accepted';
  exception when unique_violation then null;
  end;
end $$;

-- Deleting the login deletes the account and everything hanging off it.
insert into public.stripe_customers (customer_id, user_id, email)
  values ('cus_T1', 'a0000000-0000-4000-8000-000000000001', 'new@example.com');
insert into public.subscriptions (subscription_id, customer_id, status)
  values ('sub_T1', 'cus_T1', 'active');
delete from auth.users where id = 'a0000000-0000-4000-8000-000000000001';
do $$ begin
  assert not exists (select 1 from public.accounts where user_id = 'a0000000-0000-4000-8000-000000000001'), 'account gone';
  assert not exists (select 1 from public.entitlements where user_id = 'a0000000-0000-4000-8000-000000000001'), 'entitlement gone';
  assert not exists (select 1 from public.stripe_customers where customer_id = 'cus_T1'), 'customer link gone';
  assert not exists (select 1 from public.subscriptions where subscription_id = 'sub_T1'), 'subscription gone';
end $$;

-- Stripe IDs are checked.
insert into auth.users (id, email) values ('a0000000-0000-4000-8000-000000000004', 'ids@example.com');
do $$ begin
  begin
    insert into public.stripe_customers (customer_id, user_id) values ('sub_wrong', 'a0000000-0000-4000-8000-000000000004');
    raise exception 'a customer ID that is not cus_ was accepted';
  exception when check_violation then null;
  end;
end $$;

rollback;
