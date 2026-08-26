// lib/store.js
//
// Хранилище заказов пополнения Steam.
//
// ВАЖНО про Vercel: serverless-функции не имеют постоянной файловой системы —
// всё, что вы запишете на диск, живёт только в рамках одного вызова функции
// (а часто и того меньше). Поэтому в проде это хранилище работает через
// Upstash Redis (подключается в Vercel как Marketplace-интеграция "Redis" —
// см. README), если заданы соответствующие переменные окружения. Если их
// нет (например, локальная разработка), хранилище работает через JSON-файл
// в /tmp — этого достаточно для разработки, но НЕ для продакшена на Vercel.
//
// Поддерживаются оба варианта именования переменных, которые встречаются
// у Upstash/Vercel-интеграций: UPSTASH_REDIS_REST_URL/TOKEN и старые
// KV_REST_API_URL/TOKEN (для проектов, где Vercel KV был подключён раньше).

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const hasRedis = Boolean(REDIS_URL && REDIS_TOKEN);

const ORDER_PREFIX = 'order:';

let redisClient = null;
function getRedis() {
  if (!redisClient) {
    // требует зависимости "@upstash/redis" (см. package.json)
    const { Redis } = require('@upstash/redis');
    redisClient = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  }
  return redisClient;
}

// ---- файловый фолбэк (только для локальной разработки) ----
const fs = require('fs');
const path = require('path');
const FILE = path.join(require('os').tmpdir(), 'duskey-orders.json');

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

async function saveOrder(order) {
  if (hasRedis) {
    await getRedis().set(ORDER_PREFIX + order.order_id, JSON.stringify(order));
    return;
  }
  const all = fileReadAll();
  all[order.order_id] = order;
  fileWriteAll(all);
}

async function getOrder(order_id) {
  if (hasRedis) {
    const raw = await getRedis().get(ORDER_PREFIX + order_id);
    if (!raw) return undefined;
    // @upstash/redis обычно уже парсит JSON сам, но подстрахуемся на случай
    // строкового ответа
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }
  return fileReadAll()[order_id];
}

async function updateOrderStatus(order_id, status, callbackPayload) {
  const existing = (await getOrder(order_id)) || { order_id };
  existing.status = status;
  existing.last_callback = callbackPayload;
  existing.updated_at = new Date().toISOString();
  await saveOrder(existing);
  return existing;
}

module.exports = { saveOrder, getOrder, updateOrderStatus, usingRedis: hasRedis };
