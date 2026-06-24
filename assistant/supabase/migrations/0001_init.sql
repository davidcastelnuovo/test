-- ════════════════════════════════════════════════════════════════════════
-- בסיס נתונים לעוזר (Vercel + Supabase) — שיחות והודעות פר-משתמש
-- הרץ את הקובץ הזה ב-Supabase: SQL Editor → הדבק → Run
-- (או דרך Supabase CLI: supabase db push)
-- ════════════════════════════════════════════════════════════════════════

-- ── פרופילים: שורה לכל משתמש מאומת ──────────────────────────────────────
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at  timestamptz not null default now()
);

-- יצירת פרופיל אוטומטית בעת הרשמה
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── שיחות ────────────────────────────────────────────────────────────────
create table if not exists public.conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  title      text not null default 'שיחה חדשה',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists conversations_user_idx
  on public.conversations (user_id, updated_at desc);

-- ── הודעות ───────────────────────────────────────────────────────────────
create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  role            text not null check (role in ('user', 'assistant', 'system')),
  content         text not null default '',
  cost_usd        numeric(12, 6) not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists messages_conversation_idx
  on public.messages (conversation_id, created_at);

-- עדכון updated_at של השיחה כשנוספת הודעה
create or replace function public.touch_conversation()
returns trigger
language plpgsql
as $$
begin
  update public.conversations
     set updated_at = now()
   where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists on_message_insert on public.messages;
create trigger on_message_insert
  after insert on public.messages
  for each row execute function public.touch_conversation();

-- ════════════════════════════════════════════════════════════════════════
-- RLS — כל משתמש רואה ועורך אך ורק את הנתונים שלו
-- ════════════════════════════════════════════════════════════════════════
alter table public.profiles      enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;

-- profiles
create policy "profiles: self read"   on public.profiles
  for select using (auth.uid() = id);
create policy "profiles: self update" on public.profiles
  for update using (auth.uid() = id);

-- conversations
create policy "conversations: owner all" on public.conversations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- messages
create policy "messages: owner all" on public.messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
