create extension if not exists pgcrypto;

create table if not exists public.incidents (
  id uuid primary key default gen_random_uuid(),
  source_id text not null unique,
  title text not null,
  summary text,
  category text not null check (category in ('political','fraud','entertainment')),
  category_label text not null,
  confidence numeric(3,2) not null default 0.50,
  source_domain text,
  platform text,
  source_type text not null default 'news' check (source_type in ('news','factcheck','social_report')),
  claim_url text,
  reported_on text,
  article_url text,
  image_url text,
  image_type text not null default 'documented' check (image_type in ('documented')),
  rights_status text not null default 'link_only' check (rights_status in ('licensed','public_reporting_use','link_only','unknown')),
  usage_note text,
  modalities text[] not null default array['image']::text[],
  tags text[] not null default array[]::text[],
  harm_level text not null default 'low' check (harm_level in ('low','medium','high')),
  source_priority text not null default 'other' check (source_priority in ('factchecker','major_outlet','other')),
  incident_key text,
  country text,
  language text,
  published_at timestamptz not null default now(),
  status text not null default 'reported_as_synthetic',
  created_at timestamptz not null default now()
);

alter table public.incidents add column if not exists source_type text not null default 'news';
alter table public.incidents add column if not exists claim_url text;
alter table public.incidents add column if not exists reported_on text;
alter table public.incidents add column if not exists modalities text[] not null default array['image']::text[];
alter table public.incidents add column if not exists tags text[] not null default array[]::text[];
alter table public.incidents add column if not exists harm_level text not null default 'low';
alter table public.incidents add column if not exists source_priority text not null default 'other';
alter table public.incidents add column if not exists incident_key text;
update public.incidents set image_type = 'documented' where image_type in ('redacted','illustrative');
alter table public.incidents drop constraint if exists incidents_image_type_check;
alter table public.incidents add constraint incidents_image_type_check
  check (image_type in ('documented'));
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'incidents_source_type_check'
  ) then
    alter table public.incidents
      add constraint incidents_source_type_check
      check (source_type in ('news','factcheck','social_report'));
  end if;
end $$;

update public.incidents
set category = case
  when category in ('celeb','culture','audio','synthetic') then 'entertainment'
  when category in ('fraud','political','entertainment') then category
  else 'entertainment'
end;

alter table public.incidents drop constraint if exists incidents_category_check;
alter table public.incidents
  add constraint incidents_category_check
  check (category in ('political','fraud','entertainment'));

alter table public.incidents drop constraint if exists incidents_harm_level_check;
alter table public.incidents
  add constraint incidents_harm_level_check
  check (harm_level in ('low','medium','high'));

alter table public.incidents drop constraint if exists incidents_source_priority_check;
alter table public.incidents
  add constraint incidents_source_priority_check
  check (source_priority in ('factchecker','major_outlet','other'));

alter table public.historical_verified_incidents drop constraint if exists historical_verified_incidents_category_check;
alter table public.historical_verified_incidents
  add constraint historical_verified_incidents_category_check
  check (category in ('political','fraud','entertainment'));
update public.historical_verified_incidents set image_type = 'documented' where image_type in ('redacted','illustrative');
alter table public.historical_verified_incidents drop constraint if exists historical_verified_incidents_image_type_check;
alter table public.historical_verified_incidents add constraint historical_verified_incidents_image_type_check
  check (image_type in ('documented'));

create table if not exists public.ingest_runs (
  id uuid primary key default gen_random_uuid(),
  fetched integer not null default 0,
  upserted integer not null default 0,
  run_at timestamptz not null default now()
);

create table if not exists public.historical_verified_incidents (
  id uuid primary key default gen_random_uuid(),
  source_id text not null unique,
  title text not null,
  summary text,
  category text not null check (category in ('political','fraud','celeb','culture','synthetic','audio')),
  category_label text not null,
  confidence numeric(3,2) not null default 0.90,
  platform text,
  source_domain text,
  source_url text,
  image_url text,
  image_type text not null default 'documented' check (image_type in ('documented')),
  rights_status text not null default 'public_reporting_use' check (rights_status in ('licensed','public_reporting_use','link_only','unknown')),
  usage_note text,
  reach_estimate text,
  debunked boolean,
  published_at timestamptz not null,
  status text not null default 'verified_archive',
  created_at timestamptz not null default now()
);

create table if not exists public.context_articles (
  id uuid primary key default gen_random_uuid(),
  source_id text not null unique,
  title text not null,
  summary text,
  topic_label text not null default 'Public Impact',
  source_domain text,
  article_url text,
  image_url text,
  published_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists incidents_published_at_idx on public.incidents (published_at desc);
create index if not exists incidents_category_idx on public.incidents (category);
create index if not exists incidents_incident_key_idx on public.incidents (incident_key);
create index if not exists incidents_harm_level_idx on public.incidents (harm_level);
create index if not exists incidents_platform_idx on public.incidents (platform);
create index if not exists incidents_source_type_idx on public.incidents (source_type);
create index if not exists ingest_runs_run_at_idx on public.ingest_runs (run_at desc);
create index if not exists historical_verified_published_at_idx on public.historical_verified_incidents (published_at desc);
create index if not exists context_articles_published_at_idx on public.context_articles (published_at desc);

alter table public.incidents enable row level security;
alter table public.ingest_runs enable row level security;
alter table public.historical_verified_incidents enable row level security;
alter table public.context_articles enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'incidents' and policyname = 'Allow read incidents'
  ) then
    create policy "Allow read incidents"
      on public.incidents
      for select
      to anon, authenticated
      using (true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'ingest_runs' and policyname = 'Allow read ingest runs'
  ) then
    create policy "Allow read ingest runs"
      on public.ingest_runs
      for select
      to anon, authenticated
      using (true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'context_articles' and policyname = 'Allow read context articles'
  ) then
    create policy "Allow read context articles"
      on public.context_articles
      for select
      to anon, authenticated
      using (true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'historical_verified_incidents' and policyname = 'Allow read verified archive'
  ) then
    create policy "Allow read verified archive"
      on public.historical_verified_incidents
      for select
      to anon, authenticated
      using (true);
  end if;
end $$;

create or replace function public.top_platform()
returns table(platform text, total bigint)
language sql
stable
as $$
  select coalesce(platform, 'Unknown') as platform, count(*) as total
  from public.incidents
  group by 1
  order by 2 desc
  limit 1;
$$;

grant execute on function public.top_platform() to anon, authenticated;
