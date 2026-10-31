-- =====================================================
-- Database Schema for Ice Cream Batch Tracker
-- Run this script in the Supabase SQL Editor
-- =====================================================

-- Enable UUID extension if not already enabled
create extension if not exists "uuid-ossp";

-- 1. Create table 'lots' (จัดการรอบการขาย)
create table if not exists public.lots (
    id uuid primary key default gen_random_uuid(),
    cost numeric not null default 5000,
    float_money numeric not null default 500,
    total_collected numeric not null default 0,
    status text not null default 'active' check (status in ('active', 'closed')),
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    closed_at timestamp with time zone null
);

-- 2. Create table 'daily_sales' (บันทึกยอดเงินรายวัน)
create table if not exists public.daily_sales (
    id uuid primary key default gen_random_uuid(),
    lot_id uuid not null references public.lots(id) on delete cascade,
    amount numeric not null check (amount >= 0),
    shift text not null default 'lunch' check (shift in ('lunch', 'afternoon')),
    note text default '',
    float_deducted numeric default 0,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Migration helper (in case tables were already created earlier)
alter table public.lots add column if not exists float_money numeric not null default 500;
alter table public.daily_sales add column if not exists shift text not null default 'lunch';
alter table public.daily_sales add column if not exists note text default '';
alter table public.daily_sales add column if not exists float_deducted numeric default 0;

-- 3. Indexes for fast querying
create index if not exists idx_lots_status on public.lots(status);
create index if not exists idx_daily_sales_lot_id on public.daily_sales(lot_id);
create index if not exists idx_daily_sales_created_at on public.daily_sales(created_at desc);

-- 4. Enable Row Level Security (RLS)
alter table public.lots enable row level security;
alter table public.daily_sales enable row level security;

-- 5. Open access policy for teacher's client app (using anon key)
-- Can be restricted later with Supabase Auth if needed
create policy "Allow all operations for anon on lots" 
on public.lots for all 
to anon 
using (true) 
with check (true);

create policy "Allow all operations for anon on daily_sales" 
on public.daily_sales for all 
to anon 
using (true) 
with check (true);

-- 6. Insert initial active lot if no lots exist
insert into public.lots (cost, total_collected, status)
select 5000, 0, 'active'
where not exists (
    select 1 from public.lots where status = 'active'
);

-- 7. Create table 'products' (แคตตาล็อกสินค้าไอศกรีม & คำนวณกำไร)
create table if not exists public.products (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    category text not null default 'แท่ง',
    pieces_per_box integer not null default 24 check (pieces_per_box > 0),
    cost_per_piece numeric not null check (cost_per_piece >= 0),
    retail_price numeric not null check (retail_price >= 0),
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.products enable row level security;

drop policy if exists "Allow all operations for anon on products" on public.products;
create policy "Allow all operations for anon on products"
on public.products for all to anon using (true) with check (true);
