// routes/tamagotchi.js
//
// Бонусный питомец (см. .tama-section в public/index.html). Хранится в
// таблице tamagotchi_pets в Supabase (схема — supabase/schema.sql).
//
// ВАЖНО: формулы "голода/бодрости/радости", прогресс (опыт/уровень/монеты),
// каталог магазина, инвентарь еды/игрушек и стрик ежедневных наград
// продублированы на клиенте (см. applyTamaDecay/tamaApplyAction/
// TAMA_SHOP_CATALOG в public/index.html) — это осознанный дубль, а не
// забытый рефакторинг: клиент должен уметь работать точно так же и без
// сервера (offline-режим, когда Supabase не подключён или недоступен),
// поэтому логика должна совпадать в обоих местах. Меняете баланс/цены —
// меняйте в обоих файлах.
const express = require('express');
const router = express.Router();
const { supabase, isConfigured } = require('../lib/supabase');

const TABLE = 'tamagotchi_pets';

// Баланс монет — важная заметка для будущих правок (2026): аудит показал,
// что при HAPPY_PER_MIN=1/8 и PET_COOLDOWN=24ч расход монет на поддержание
// счастья одними игрушками составлял ~135 монет/день при доходе ~25-30
// монет/день — гарантированный уход в минус для активного игрока. Вернули
// голод к прежней скорости, ослабили радость и сделали глажку регулярным
// (не разовым) бесплатным источником радости — теперь вовлечённый игрок
// покрывает большую часть радости просто взаимодействием, а не гриндом.
//
// 2026, повторная правка по запросу: голод/бодрость/радость должны падать
// заметнее, чтобы за характеристиками хотелось следить минимум 2 раза в
// день, но без фарма — coin-бэк за еду/игрушки/сон при этом снижен (см.
// SHOP_CATALOG и sleep-награду ниже). Радость по-прежнему в основном
// закрывается бесплатной регулярной глажкой, а не покупками, поэтому
// ускорение её распада не давит на монетный баланс так, как раньше
const HUNGER_PER_MIN = 1 / 6;        // +1 голода каждые 6 минут (было 1/8) — до "грустно" (75) ~7.5ч на 1 уровне
const ENERGY_AWAKE_PER_MIN = 1 / 5;  // -1 бодрости каждые 5 минут, если не спит (было 1/6)
const ENERGY_SLEEP_PER_MIN = 2 / 10; // +2 бодрости каждые 10 минут, пока спит
const HAPPY_PER_MIN = 1 / 10;        // -1 радости каждые 10 минут (было 1/20) — компенсируется бесплатной глажкой
const PET_COOLDOWN_MS = 3 * 60 * 1000; // поглаживание даёт награду не чаще раза в 3 минуты — снова регулярный бесплатный источник радости, а не разовая награда раз в сутки

// прокачка даёт не только косметику — с уровнем питомец становится
// самостоятельнее: голод/усталость/скука наступают медленнее (но не
// исчезают совсем — пол в 65% от базовой скорости, достигается к 8
// уровню). Держим идентичной клиентской tamaCareEaseFactor в public/index.html
function careEaseFactor(level) {
  const step = Math.min((level || 1) - 1, 7) * 0.05;
  return Math.max(0.65, 1 - step);
}

// анти-фарм: если потребность и так закрыта, действие блокируется (без
// траты еды/игрушки и без опыта) — питомец вместо этого "думает" вслух
// (см. blocked-сообщения ниже, на клиенте это всплывающая мысль над головой)
const HUNGER_FULL_MAX = 8;    // hunger — это "насколько голоден" (0 = сыт), ниже этого сыт
const HAPPY_PLAY_MAX = 92;    // выше этого — уже и так очень весело, играть незачем
const ENERGY_AWAKE_MAX = 95;  // выше этого — и так бодрый, спать незачем

const clamp = (n) => Math.max(0, Math.min(100, n));

function applyDecay(pet) {
  const minutes = Math.max(0, (Date.now() - new Date(pet.updated_at).getTime()) / 60000);
  const ease = careEaseFactor(pet.level);
  return {
    ...pet,
    hunger: clamp(pet.hunger + minutes * HUNGER_PER_MIN * ease),
    energy: clamp(pet.energy + minutes * (pet.is_sleeping ? ENERGY_SLEEP_PER_MIN : -ENERGY_AWAKE_PER_MIN * ease)),
    happiness: clamp(pet.happiness - minutes * HAPPY_PER_MIN * ease),
  };
}

// -- прогресс, монеты, магазин, стрик (см. одноимённые функции в
// public/index.html — держим формулы идентичными) --------------------

function xpToLevel(level) { return 40 + (level - 1) * 20; }

function awardXp(pet, amount) {
  let xp = (pet.xp || 0) + amount;
  let level = pet.level || 1;
  let coins = pet.coins || 0;
  let leveledUp = false;
  while (xp >= xpToLevel(level)) {
    xp -= xpToLevel(level);
    level += 1;
    coins += 10 + level * 2;
    leveledUp = true;
  }
  return { pet: { ...pet, xp, level, coins }, leveledUp, newLevel: level };
}

// каталог магазина — держим идентичным TAMA_SHOP_CATALOG в public/index.html.
// food/toy — расходники, копятся стопкой в pet.food / pet.toys и тратятся
// по одному через кормление/игру; accessory/background — косметика,
// покупается один раз и переключается через applyEquip
// coin-бэк за еду/игрушки и лимит монет за сон немного снижены (2026,
// доп. правка поверх аудита выше) — по запросу должны начисляться
// "в пределах разумного": голод/бодрость теперь распадаются быстрее (см.
// HUNGER_PER_MIN/ENERGY_AWAKE_PER_MIN), а компенсировать это чистым
// coin-фармом через еду/сон/игрушки не должно быть слишком выгодно —
// основной доход остаётся из ежедневного бонуса и уровней
const SHOP_CATALOG = {
  food_crumbs:   { price: 4,  kind: 'food', hunger: 15,  happiness: 2,  xp: 3,  coin: 1 },
  food_kibble:   { price: 8,  kind: 'food', hunger: 30,  happiness: 4,  xp: 5,  coin: 1 },
  food_canned:   { price: 14, kind: 'food', hunger: 45,  happiness: 6,  xp: 7,  coin: 1 },
  food_fish:     { price: 22, kind: 'food', hunger: 60,  happiness: 10, xp: 10, coin: 1 },
  food_steak:    { price: 34, kind: 'food', hunger: 80,  happiness: 14, xp: 14, coin: 2, levelReq: 3 },
  food_cake:     { price: 50, kind: 'food', hunger: 100, happiness: 25, xp: 20, coin: 2, levelReq: 5 },
  food_delicacy: { price: 75, kind: 'food', hunger: 100, happiness: 30, xp: 28, coin: 3, levelReq: 8 },
  toy_ball:      { price: 10, kind: 'toy', happiness: 12, energy: 8,  hunger: 6,  xp: 6,  coin: 1 },
  toy_rope:      { price: 16, kind: 'toy', happiness: 18, energy: 10, hunger: 8,  xp: 9,  coin: 1 },
  toy_frisbee:   { price: 26, kind: 'toy', happiness: 25, energy: 14, hunger: 10, xp: 13, coin: 1, levelReq: 3 },
  toy_laser:     { price: 40, kind: 'toy', happiness: 35, energy: 18, hunger: 12, xp: 18, coin: 2, levelReq: 6 },
  bow:       { price: 15, kind: 'accessory' },
  scarf:     { price: 18, kind: 'accessory' },
  glasses:   { price: 20, kind: 'accessory', levelReq: 2 },
  cap:       { price: 24, kind: 'accessory', levelReq: 3 },
  crown:     { price: 60, kind: 'accessory', levelReq: 5 },
  bg_sunset: { price: 25, kind: 'background' },
  bg_night:  { price: 30, kind: 'background', levelReq: 2 },
  bg_space:  { price: 45, kind: 'background', levelReq: 4 },
  bg_aurora: { price: 70, kind: 'background', levelReq: 7 },
  chair_stool:    { price: 12, kind: 'furniture' },
  chair_wood:     { price: 26, kind: 'furniture' },
  chair_armchair: { price: 48, kind: 'furniture', levelReq: 3 },
  chair_throne:   { price: 95, kind: 'furniture', levelReq: 7 },
};

// см. TAMA_FALLBACK_FOOD/TOY в public/index.html — держим идентичным
const FALLBACK_FOOD = { kind: 'food', hunger: 20, happiness: 5, xp: 4, coin: 1 };
const FALLBACK_TOY = { kind: 'toy', happiness: 10, energy: 8, hunger: 6, xp: 5, coin: 1 };

// "товар дня" — раз в сутки один случайный предмет магазина продаётся со
// скидкой 30%; выбор детерминирован датой (UTC) и порядком ключей
// SHOP_CATALOG, поэтому сервер и офлайн-клиент (см. tamaDailyDealId в
// public/index.html) всегда сходятся на одном и том же предмете без
// какого-либо обмена данными — ничего дополнительно не хранится в БД
function dailyDealSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}
function dailyDealId() {
  const ids = Object.keys(SHOP_CATALOG);
  return ids[dailyDealSeed(todayStr()) % ids.length];
}
function dealPrice(item) { return Math.max(1, Math.round(item.price * 0.7)); }

function todayStr() { return new Date().toISOString().slice(0, 10); }
function yesterdayStr() { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }
function canClaimDaily(pet) { return !pet || pet.last_daily_claim !== todayStr(); }

function dailyBonusRoll() { return 5 + Math.floor(Math.random() * 11); } // случайное 5..15

function applyDailyClaim(pet) {
  if (!canClaimDaily(pet)) return { blocked: 'Уже забрано сегодня — приходи завтра' };
  const streak = pet.last_daily_claim === yesterdayStr() ? (pet.streak || 0) + 1 : 1;
  const bonusStreak = Math.min(streak, 10);
  const coinsReward = dailyBonusRoll() + (streak % 7 === 0 ? 50 : 0);
  const xpReward = 15 + bonusStreak * 3;
  const withCoins = { ...pet, coins: (pet.coins || 0) + coinsReward, streak, last_daily_claim: todayStr(), updated_at: new Date().toISOString() };
  const xpRes = awardXp(withCoins, xpReward);
  return { pet: xpRes.pet, mood: 'play', leveledUp: xpRes.leveledUp, newLevel: xpRes.newLevel, reward: { coins: coinsReward, xp: xpReward, streak, weekly: streak % 7 === 0 } };
}

// покупка: еда/игрушки копятся стопкой (pet.food / pet.toys), косметика —
// разовая покупка в pet.inventory
function applyBuy(pet, itemId) {
  const item = SHOP_CATALOG[itemId];
  if (!item) return { blocked: 'Неизвестный товар' };
  if (item.levelReq && (pet.level || 1) < item.levelReq) return { blocked: `Доступно с ${item.levelReq} уровня` };
  const price = itemId === dailyDealId() ? dealPrice(item) : item.price;
  if ((pet.coins || 0) < price) return { blocked: 'Недостаточно монет' };
  if (item.kind === 'food' || item.kind === 'toy') {
    const field = item.kind === 'food' ? 'food' : 'toys';
    const store = { ...(pet[field] || {}) };
    store[itemId] = (store[itemId] || 0) + 1;
    return { pet: { ...pet, coins: pet.coins - price, [field]: store, updated_at: new Date().toISOString() } };
  }
  if ((pet.inventory || []).includes(itemId)) return { blocked: 'Уже куплено' };
  const next = { ...pet, coins: pet.coins - price, inventory: [...(pet.inventory || []), itemId], updated_at: new Date().toISOString() };
  return { pet: next };
}

function applyEquip(pet, slot, itemId) {
  if (itemId && !(pet.inventory || []).includes(itemId)) return { blocked: 'Это ещё не куплено' };
  const field = slot === 'background' ? 'equipped_background' : slot === 'furniture' ? 'equipped_furniture' : 'equipped_accessory';
  const current = pet[field] || null;
  const next = current === itemId ? null : itemId;
  return { pet: { ...pet, [field]: next, updated_at: new Date().toISOString() } };
}

function applyAction(pet, type, extra) {
  if (type === 'buy') return applyBuy(pet, extra && extra.itemId);
  if (type === 'equip') return applyEquip(pet, extra && extra.slot, extra && extra.itemId);
  if (type === 'claim_daily') return applyDailyClaim(pet);

  const next = { ...pet, updated_at: new Date().toISOString() };
  if (type === 'feed') {
    if (pet.is_sleeping) return { blocked: 'Он спит — не будите!' };
    if (pet.hunger <= HUNGER_FULL_MAX) return { blocked: 'Я не хочу есть — я сыт!' };
    const itemId = extra && extra.itemId;
    if (!itemId) return { blocked: 'Нет такой еды — загляните в магазин' };
    const owned = (pet.food || {})[itemId] || 0;
    if (owned <= 0) return { blocked: 'Этой еды не осталось — купите ещё в магазине' };
    const item = SHOP_CATALOG[itemId] || FALLBACK_FOOD;
    next.food = { ...pet.food, [itemId]: owned - 1 };
    next.hunger = clamp(pet.hunger - item.hunger);
    next.happiness = clamp(pet.happiness + item.happiness);
    next.coins = (pet.coins || 0) + item.coin;
    const xpRes = awardXp(next, item.xp);
    return { pet: xpRes.pet, mood: 'eat', leveledUp: xpRes.leveledUp, newLevel: xpRes.newLevel };
  }
  if (type === 'play') {
    if (pet.is_sleeping) return { blocked: 'Он спит — не будите!' };
    if (pet.energy < 15) return { blocked: 'Он устал, пусть сначала поспит' };
    if (pet.happiness >= HAPPY_PLAY_MAX) return { blocked: 'Не хочу играть — мне и так весело!' };
    const itemId = extra && extra.itemId;
    if (itemId) {
      const owned = (pet.toys || {})[itemId] || 0;
      if (owned <= 0) return { blocked: 'Этой игрушки не осталось — купите ещё в магазине' };
      const item = SHOP_CATALOG[itemId] || FALLBACK_TOY;
      next.toys = { ...pet.toys, [itemId]: owned - 1 };
      next.happiness = clamp(pet.happiness + item.happiness);
      next.energy = clamp(pet.energy - item.energy);
      next.hunger = clamp(pet.hunger + item.hunger);
      next.coins = (pet.coins || 0) + item.coin;
      const xpRes = awardXp(next, item.xp);
      return { pet: xpRes.pet, mood: 'play', leveledUp: xpRes.leveledUp, newLevel: xpRes.newLevel };
    }
    // обычная игра без игрушки — доступна всегда, но скромнее по наградам
    next.happiness = clamp(pet.happiness + 12);
    next.energy = clamp(pet.energy - 10);
    next.hunger = clamp(pet.hunger + 5);
    next.coins = (pet.coins || 0) + 1;
    const xpRes = awardXp(next, 6);
    return { pet: xpRes.pet, mood: 'play', leveledUp: xpRes.leveledUp, newLevel: xpRes.newLevel };
  }
  if (type === 'pet') {
    // поглаживание — доступно всегда (даже спящему, тихонько, без награды),
    // но чтобы свайп по экрану не фармился в бесконечный XP, реальная
    // награда засчитывается не чаще, чем раз в PET_COOLDOWN_MS — на клиенте
    // при этом анимация сердечек всё равно проигрывается каждый раз
    const last = pet.last_pet_at ? new Date(pet.last_pet_at).getTime() : 0;
    if (pet.is_sleeping) {
      return { pet, mood: 'sleep' };
    }
    if (Date.now() - last < PET_COOLDOWN_MS) {
      return { pet, mood: 'pet' };
    }
    next.happiness = clamp(pet.happiness + 6);
    next.last_pet_at = new Date().toISOString();
    const xpRes = awardXp(next, 2);
    return { pet: xpRes.pet, mood: 'pet', leveledUp: xpRes.leveledUp, newLevel: xpRes.newLevel };
  }
  if (type === 'sleep') {
    if (pet.energy >= ENERGY_AWAKE_MAX) return { blocked: 'Не хочу спать — я и так бодрый!' };
    next.is_sleeping = true;
    return { pet: next, mood: 'sleep' };
  }
  if (type === 'wake') {
    next.is_sleeping = false;
    // награда зависит от того, сколько реально проспал (по времени с
    // последнего updated_at, т.е. с клика "спать") — спам сон/будить не
    // даёт монет, а честный отдых даёт
    if (pet.is_sleeping) {
      const minutesSlept = Math.max(0, (Date.now() - new Date(pet.updated_at).getTime()) / 60000);
      const coinsEarned = Math.min(4, Math.floor(minutesSlept / 20)); // было min(6, /15) — сон тоже "чуть-чуть", не основной заработок
      if (coinsEarned > 0) {
        next.coins = (pet.coins || 0) + coinsEarned;
        const xpRes = awardXp(next, coinsEarned * 2);
        return { pet: xpRes.pet, mood: 'neutral', leveledUp: xpRes.leveledUp, newLevel: xpRes.newLevel, reward: { coins: coinsEarned } };
      }
    }
    return { pet: next, mood: 'neutral' };
  }
  return { pet };
}

// добивает недостающие поля прогресса у записей, заведённых до этой фичи
function ensureFields(pet) {
  return {
    ...pet,
    level: pet.level || 1,
    xp: pet.xp || 0,
    coins: pet.coins != null ? pet.coins : 20,
    streak: pet.streak || 0,
    last_daily_claim: pet.last_daily_claim || null,
    inventory: pet.inventory || [],
    equipped_accessory: pet.equipped_accessory || null,
    equipped_background: pet.equipped_background || null,
    equipped_furniture: pet.equipped_furniture || null,
    food: pet.food || {},
    toys: pet.toys || {},
    last_pet_at: pet.last_pet_at || null,
  };
}

// если Supabase не подключён — сразу и честно 503 (но только для своих
// путей /pet/... — без явного префикса это перехватывало бы вообще все
// запросы в приложении, включая раздачу статики). Фронтенд сам уходит в
// localStorage при любой не-2xx ошибке (см. TamaStore в public/index.html)
router.use('/pet', (req, res, next) => {
  if (!isConfigured) return res.status(503).json({ ok: false, error: 'Supabase не подключён' });
  next();
});

router.get('/pet/:ownerId', async (req, res) => {
  const { data, error } = await supabase.from(TABLE).select('*').eq('owner_id', req.params.ownerId).maybeSingle();
  if (error) {
    console.error('tamagotchi get error:', error);
    return res.status(502).json({ ok: false, error: 'Не удалось загрузить питомца' });
  }
  if (!data) return res.status(404).json({ ok: false });
  res.json(applyDecay(ensureFields(data)));
});

router.post('/pet/:ownerId', async (req, res) => {
  const { species, name } = req.body || {};
  if (species !== 'cat' && species !== 'dog') {
    return res.status(400).json({ ok: false, error: 'species должен быть cat или dog' });
  }
  const row = {
    owner_id: req.params.ownerId,
    species,
    name: (name || (species === 'cat' ? 'Котёнок' : 'Щенок')).slice(0, 16),
    hunger: 20,
    energy: 90,
    happiness: 90,
    is_sleeping: false,
    level: 1,
    xp: 0,
    coins: 12,
    streak: 0,
    last_daily_claim: null,
    inventory: [],
    equipped_accessory: null,
    equipped_background: null,
    equipped_furniture: null,
    food: { food_crumbs: 3 }, // стартовый набор, чтобы было чем покормить сразу
    toys: {},
    last_pet_at: null,
    updated_at: new Date().toISOString(),
  };
  // upsert — повторное «завести» с тем же owner_id просто вернёт того же
  // питомца, а не упадёт на дубликате primary key
  const { data, error } = await supabase.from(TABLE).upsert(row, { onConflict: 'owner_id' }).select().single();
  if (error) {
    console.error('tamagotchi create error:', error);
    return res.status(502).json({ ok: false, error: 'Не удалось завести питомца' });
  }
  res.json(ensureFields(data));
});

router.post('/pet/:ownerId/action', async (req, res) => {
  const { action, itemId, slot } = req.body || {};
  if (!['feed', 'play', 'pet', 'sleep', 'wake', 'claim_daily', 'buy', 'equip'].includes(action)) {
    return res.status(400).json({ ok: false, error: 'Неизвестное действие' });
  }
  const { data: existing, error: readErr } = await supabase.from(TABLE).select('*').eq('owner_id', req.params.ownerId).maybeSingle();
  if (readErr) {
    console.error('tamagotchi action read error:', readErr);
    return res.status(502).json({ ok: false, error: 'Не удалось загрузить питомца' });
  }
  if (!existing) return res.status(404).json({ ok: false, error: 'Питомец не найден' });

  const decayed = applyDecay(ensureFields(existing));
  const result = applyAction(decayed, action, { itemId, slot });
  if (result.blocked) return res.json({ blocked: result.blocked });

  const { data, error } = await supabase.from(TABLE).update(result.pet).eq('owner_id', req.params.ownerId).select().single();
  if (error) {
    console.error('tamagotchi action write error:', error);
    return res.status(502).json({ ok: false, error: 'Не удалось сохранить изменения' });
  }
  res.json({ pet: ensureFields(data), mood: result.mood, leveledUp: result.leveledUp, newLevel: result.newLevel, reward: result.reward });
});

module.exports = router;
