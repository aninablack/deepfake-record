create table if not exists public.incident_events (
  id uuid primary key default gen_random_uuid(),
  source_id text,
  article_url text,
  title text,
  category text,
  confidence numeric(4,3),
  source_domain text,
  source_type text,
  image_type text,
  published_at timestamptz,
  seen_at timestamptz not null default now()
);

create index if not exists incident_events_seen_at_idx
  on public.incident_events (seen_at desc);

create index if not exists incident_events_source_id_idx
  on public.incident_events (source_id);

alter table public.incident_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'incident_events'
      and policyname = 'allow_read_incident_events'
  ) then
    create policy allow_read_incident_events
      on public.incident_events
      for select
      to anon, authenticated
      using (true);
  end if;
end $$;

grant select on public.incident_events to anon, authenticated;
grant select, insert on public.incident_events to service_role;
