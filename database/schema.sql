create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  full_name text default '',
  admin boolean not null default false,
  is_registered boolean not null default true,
  hashed_password text not null,
  created_at timestamptz not null default now()
);

create table if not exists brands (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text default '',
  created_at timestamptz not null default now()
);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  product_id uuid generated always as (id) stored,
  type text not null,
  brand_id uuid references brands(id) on delete cascade,
  short_name text default '',
  title text not null,
  price numeric default 0,
  description text default '',
  warranty numeric default 0,
  images jsonb not null default '[]'::jsonb,
  specs_raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists products_type_idx on products(type);
create index if not exists products_brand_id_idx on products(brand_id);
create index if not exists products_title_idx on products(title);

-- Seed the admin manually after choosing credentials:
-- insert into users (username, full_name, admin, hashed_password)
-- values ('admin', 'Compu Magic Admin', true, '<sha256-password-hash>');
