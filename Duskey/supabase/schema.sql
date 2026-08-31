-- supabase/schema.sql
--
-- Таблица для бонусного тамагочи (routes/tamagotchi.js). Выполните этот
-- файл один раз в Supabase → SQL Editor вашего проекта.
--
-- RLS (Row Level Security) намеренно НЕ включён: запись/чтение идёт
-- только с сервера через Service Role Key (lib/supabase.js), браузер
-- напрямую в Supabase не стучится, поэтому политики доступа тут не
-- нужны — сервер сам решает, что можно конкретному owner_id.

create table if not exists tamagotchi_pets (
  owner_id             text primary key,              -- 'tg_<telegram_id>' или 'web_<случайный id>' — см. getTamaOwnerId() на фронте
  species              text not null check (species in ('cat', 'dog')),
  name                 text not null default 'Питомец',
  hunger               numeric not null default 20,   -- 0 = сыт, 100 = голоден
  energy               numeric not null default 90,   -- 0 = устал, 100 = бодр
  happiness            numeric not null default 90,   -- 0 = грустит, 100 = радуется
  is_sleeping          boolean not null default false,
  level                integer not null default 1,    -- уровень питомца (растёт от опыта — см. routes/tamagotchi.js)
  xp                   integer not null default 0,    -- опыт в рамках текущего уровня
  coins                integer not null default 20,   -- игровая валюта для магазина (routes/tamagotchi.js: SHOP_CATALOG)
  streak               integer not null default 0,    -- текущий стрик ежедневных заходов
  last_daily_claim     date,                           -- дата (UTC) последнего забора ежедневной награды
  inventory            jsonb not null default '[]',   -- id купленных предметов магазина (аксессуары/фоны)
  equipped_accessory   text,                           -- id надетого аксессуара (или null)
  equipped_background  text,                           -- id выбранного фона сцены (или null)
  equipped_furniture   text,                           -- id выбранной мебели под питомцем (или null)
  food                 jsonb not null default '{}',   -- { itemId: количество } — купленная еда, тратится по 1 за кормление
  toys                 jsonb not null default '{}',   -- { itemId: количество } — купленные игрушки, тратятся по 1 за игру
  last_pet_at          timestamptz,                    -- когда последний раз погладили (кулдаун награды за поглаживание)
  link_code            text unique,                    -- случайный идентификатор для переноса питомца на другое устройство/в Telegram (см. /pet/link в routes/tamagotchi.js) — генерируется сервером, никогда не задаётся пользователем
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- на случай, если таблица уже существует из более ранней версии схемы
-- (без прогресса/магазина/инвентаря еды) — добавляем недостающие колонки
-- безопасно
alter table tamagotchi_pets add column if not exists level integer not null default 1;
alter table tamagotchi_pets add column if not exists xp integer not null default 0;
alter table tamagotchi_pets add column if not exists coins integer not null default 20;
alter table tamagotchi_pets add column if not exists streak integer not null default 0;
alter table tamagotchi_pets add column if not exists last_daily_claim date;
alter table tamagotchi_pets add column if not exists inventory jsonb not null default '[]';
alter table tamagotchi_pets add column if not exists equipped_accessory text;
alter table tamagotchi_pets add column if not exists equipped_background text;
alter table tamagotchi_pets add column if not exists equipped_furniture text;
alter table tamagotchi_pets add column if not exists food jsonb not null default '{}';
alter table tamagotchi_pets add column if not exists toys jsonb not null default '{}';
alter table tamagotchi_pets add column if not exists last_pet_at timestamptz;
alter table tamagotchi_pets add column if not exists link_code text unique;

comment on table tamagotchi_pets is 'Бонусный питомец на сайте — один на owner_id (см. routes/tamagotchi.js): статы, уровень/опыт, монеты, магазин (еда/игрушки копятся стопкой, аксессуары/фоны — разово), стрик ежедневных наград.';
