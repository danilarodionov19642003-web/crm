-- Isolated development-project workspace.
-- It deliberately has no foreign keys, triggers or functions touching crm_state,
-- clients, reviews, tasks, subscriptions or the mentoring workflow.

begin;

create table if not exists public.development_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  client_name text not null check (char_length(btrim(client_name)) between 1 and 160),
  stage text not null default 'discussion' check (stage in (
    'discussion', 'proposal', 'prepayment', 'analysis', 'prototype',
    'development', 'testing', 'launch', 'support', 'completed'
  )),
  status text not null default 'active' check (status in (
    'active', 'waiting_client', 'paused', 'completed', 'archived'
  )),
  health text not null default 'ok' check (health in ('ok', 'attention', 'problem')),
  description text not null default '' check (char_length(description) <= 5000),
  start_date date,
  deadline date,
  next_action text not null default '' check (char_length(next_action) <= 1000),
  next_action_date date,
  waiting_for_client text not null default '' check (char_length(waiting_for_client) <= 1000),
  contract_amount numeric(14,2) not null default 0 check (contract_amount >= 0),
  received_amount numeric(14,2) not null default 0 check (received_amount >= 0),
  expense_amount numeric(14,2) not null default 0 check (expense_amount >= 0),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.development_project_activity (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.development_projects(id) on delete cascade,
  kind text not null default 'note' check (kind in ('note', 'stage', 'finance', 'release', 'client')),
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  happened_at timestamptz not null default now(),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.development_project_resources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.development_projects(id) on delete cascade,
  kind text not null default 'document' check (kind in (
    'document', 'site', 'repository', 'server', 'database', 'bot', 'design', 'other'
  )),
  label text not null check (char_length(btrim(label)) between 1 and 200),
  url text not null default '' check (char_length(url) <= 2000),
  login text not null default '' check (char_length(login) <= 300),
  notes text not null default '' check (char_length(notes) <= 2000),
  expires_on date,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists development_projects_status_idx
  on public.development_projects (status, updated_at desc);
create index if not exists development_project_activity_project_idx
  on public.development_project_activity (project_id, happened_at desc);
create index if not exists development_project_resources_project_idx
  on public.development_project_resources (project_id, created_at desc);

alter table public.development_projects enable row level security;
alter table public.development_project_activity enable row level security;
alter table public.development_project_resources enable row level security;

drop policy if exists development_projects_owner_all on public.development_projects;
create policy development_projects_owner_all on public.development_projects
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner');

drop policy if exists development_project_activity_owner_all on public.development_project_activity;
create policy development_project_activity_owner_all on public.development_project_activity
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner');

drop policy if exists development_project_resources_owner_all on public.development_project_resources;
create policy development_project_resources_owner_all on public.development_project_resources
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner');

grant select, insert, update, delete on public.development_projects to authenticated;
grant select, insert, update, delete on public.development_project_activity to authenticated;
grant select, insert, update, delete on public.development_project_resources to authenticated;
grant all on public.development_projects to service_role;
grant all on public.development_project_activity to service_role;
grant all on public.development_project_resources to service_role;

create or replace function public.touch_development_project_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists development_projects_touch_updated_at on public.development_projects;
create trigger development_projects_touch_updated_at
  before update on public.development_projects
  for each row execute function public.touch_development_project_updated_at();

drop trigger if exists development_project_resources_touch_updated_at on public.development_project_resources;
create trigger development_project_resources_touch_updated_at
  before update on public.development_project_resources
  for each row execute function public.touch_development_project_updated_at();

revoke all on function public.touch_development_project_updated_at() from public, anon, authenticated;
grant execute on function public.touch_development_project_updated_at() to service_role;

commit;
