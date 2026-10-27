-- Passwords can never be used: they're dropped when written, and a password
-- session sees no account. Rolled back.
begin;

-- Set at sign-up (a password sign-up with someone else's email, say): dropped.
insert into auth.users (id, email, encrypted_password)
  values ('d0000000-0000-4000-8000-000000000001', 'victim@example.com', '$2a$10$attackerhashattackerhash');
do $$ begin
  assert (select encrypted_password from auth.users where id = 'd0000000-0000-4000-8000-000000000001') = '',
         'a password given at sign-up is dropped';
end $$;

-- Set later (an update, or an admin setting one): dropped too.
update auth.users set encrypted_password = '$2a$10$setlatersetlatersetlater'
  where id = 'd0000000-0000-4000-8000-000000000001';
do $$ begin
  assert (select encrypted_password from auth.users where id = 'd0000000-0000-4000-8000-000000000001') = '',
         'a password set later is dropped';
end $$;

-- Confirming the email (the owner's first code login) changes nothing about that.
update auth.users set email_confirmed_at = now() where id = 'd0000000-0000-4000-8000-000000000001';
do $$ begin
  assert (select encrypted_password from auth.users where id = 'd0000000-0000-4000-8000-000000000001') = '',
         'still no password after confirming';
end $$;

-- A session that came from a password sees no account; a code session does.
select set_config('request.jwt.claims',
  '{"sub": "d0000000-0000-4000-8000-000000000001", "role": "authenticated", "amr": [{"method": "password", "timestamp": 1}]}', true);
set local role authenticated;
do $$ begin
  assert (select count(*) from public.my_account()) = 0, 'password session: nothing';
end $$;
reset role;
select set_config('request.jwt.claims',
  '{"sub": "d0000000-0000-4000-8000-000000000001", "role": "authenticated", "amr": [{"method": "otp", "timestamp": 1}]}', true);
set local role authenticated;
do $$ begin
  assert (select count(*) from public.my_account()) = 1, 'code session: the account';
end $$;
reset role;

-- A login that existed before the migrations got its rows, and lost its password.
do $$ begin
  assert (select email from public.accounts where user_id = 'e0000000-0000-4000-8000-000000000001') = 'early@example.com',
         'existing login got an account';
  assert exists (select 1 from public.entitlements where user_id = 'e0000000-0000-4000-8000-000000000001'),
         'existing login got an entitlement row';
  assert (select encrypted_password from auth.users where id = 'e0000000-0000-4000-8000-000000000001') = '',
         'existing password dropped';
end $$;

rollback;
