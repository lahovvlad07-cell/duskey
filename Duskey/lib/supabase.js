// lib/supabase.js
//
// Клиент Supabase — используется только модулем тамагочи (см.
// routes/tamagotchi.js). Требует переменные окружения SUPABASE_URL и
// SUPABASE_SERVICE_ROLE_KEY (Project Settings → API в личном кабинете
// Supabase — Service Role, не anon: пишем в базу только с сервера, а не
// напрямую из браузера, поэтому RLS-политики можно не настраивать).
//
// Если переменные не заданы (Supabase ещё не подключён), клиент остаётся
// null — routes/tamagotchi.js в этом случае отвечает 503, а фронтенд сам
// тихо переключается на localStorage (см. TamaStore в public/index.html).
// Так сайт нормально работает и без Supabase — питомец просто не будет
// синхронизироваться между устройствами, пока база не подключена.

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
