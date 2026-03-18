create extension if not exists pgcrypto;

create table if not exists public.incidents (
  id uuid primary key default gen_random_uuid(),
  source_id text not null unique,
  title text not null,
  summary text,
  category text not null check (category in ('political','fraud','celeb','synthetic','audio')),
  category_label text not null,
  confidence numeric(3,2) not null default 0.50,
  source_domain text,
  platform text,
  article_url text,
  image_url text,
  country text,
  language text,
  published_at timestamptz not null default now(),
  status text not null default 'reported_as_synthetic',
  created_at timestamptz not null default now()
);

create index if not exists incidents_published_at_idx on public.incidents (published_at desc);
create index if not exists incidents_category_idx on public.incidents (category);
create index if not exists incidents_platform_idx on public.incidents (platform);

alter table public.incidents enable row level security;

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
