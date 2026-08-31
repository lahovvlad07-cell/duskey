// lib/supabase.js
//
// Клиент Supabase — используется только модулем тамагочи (см.
// routes/tamagotchi.js). Требует переменные окружения SUPABASE_URL и
// SUPABASE_SERVICE_ROLE_KEY (Project Settings → API в личном кабинете
// Supabase — Service Role, не anon: пишем в базу только с сервера, а не
// напрямую из браузера, поэтому RLS-политики можно не настраивать).
//
// Если переменные не заданы, клиент остаётся null — routes/tamagotchi.js
// в этом случае отвечает 503 (питомец у людей на сайте перестанет
// загружаться/сохраняться, никакого локального дублирования на клиенте
// больше нет — см. TamaStore в public/index.html). Поэтому в проде эти
// переменные должны быть заданы всегда.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  // требует зависимости "@supabase/supabase-js" (см. package.json)
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
}

module.exports = { supabase, isConfigured: Boolean(supabase) };
