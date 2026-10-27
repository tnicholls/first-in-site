-- Loaded after the stub and before the migrations (tools/test_db.py): a login
-- that already exists when the migrations run, with a password set on it.
insert into auth.users (id, email, encrypted_password, email_confirmed_at)
  values ('e0000000-0000-4000-8000-000000000001', 'Early@Example.com', '$2a$10$abcdefghijklmnopqrstuv', now());
