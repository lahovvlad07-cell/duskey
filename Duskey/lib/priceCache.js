// lib/priceCache.js
//
// Небольшой кеш общего назначения поверх того же Redis (Upstash), что и
// заказы пополнения Steam (см. lib/store.js — там же подробный комментарий
// про то, почему на Vercel нужен именно внешний кеш, а не память процесса
// или файл на диске). Используется routes/prices.js для кеша живых цен
// Digiseller — чтобы не дёргать их API на каждый заход и не зависеть от
// их доступности при каждом рендере страницы.
//
// В отличие от lib/store.js (там ключи не протухают сами), тут нужен TTL:
// у Redis это делает сам `ex`, а для файлового фолбэка (только локальная
// разработка) — проверяем срок вручную при чтении.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const hasRedis = Boolean(REDIS_URL && REDIS_TOKEN);

let redisClient = null;
function getRedis() {
  if (!redisClient) {
    // требует зависимости "@upstash/redis" (см. package.json) — она уже
    // используется в проекте для lib/store.js
    const { Redis } = require('@upstash/redis');
    redisClient = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  }
  return redisClient;
}

// ---- файловый фолбэк (только для локальной разработки, без Redis) ----
const fs = require('fs');
const path = require('path');
const FILE = path.join(require('os').tmpdir(), 'duskey-cache.json');

function fileReadAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}
function fileWriteAll(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

async function getCache(key) {
  if (hasRedis) {
    const raw = await getRedis().get(key);
    if (raw == null) return null;
    // @upstash/redis обычно уже парсит JSON сам, но подстрахуемся на
    // случай строкового ответа (см. аналогичный комментарий в lib/store.js)
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }
  const entry = fileReadAll()[key];
  if (!entry) return null;
  if (entry.expiresAt && Date.now() > entry.expiresAt) return null;
  return entry.value;
}

async function setCache(key, value, ttlSeconds) {
  if (hasRedis) {
    await getRedis().set(key, JSON.stringify(value), ttlSeconds ? { ex: ttlSeconds } : undefined);
    return;
  }
  const all = fileReadAll();
  all[key] = { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null };
  fileWriteAll(all);
}

module.exports = { getCache, setCache, usingRedis: hasRedis };
