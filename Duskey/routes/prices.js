// routes/prices.js
//
// Живые цены партнёрских товаров (Digiseller/Plati.Market) для карточек
// каталога (см. catalog в public/index.html) — чтобы priceLabel не
// расходился с реальной ценой на странице оплаты. Мы не продавец ни по
// одному из этих товаров, а только партнёр/агент (см. оферту), поэтому
// свои цены на Digiseller не задаём и должны их именно подтягивать.
//
// Используем публичный метод Digiseller "Быстрое получение описаний
// товаров по списку ID" — он НЕ требует токена продавца (то, что нужно:
// у нас нет и не должно быть доступа продавца к чужим товарам). Документация:
// https://my.digiseller.com/inside/api_catgoods.asp#products_list
//
// ВАЖНО: этот эндпоинт из документации мы не могли протестировать живым
// запросом при написании кода (нет доступа к интернету из среды разработки),
// поэтому распаковка ответа сделана защитно — пробуем несколько вероятных
// имён полей и форм ответа (массив напрямую / обёрнутый в { product: [...] }
// или { products: [...] }, см. extractPrice/extractItems ниже). Если формат
// всё же не совпадёт ни с одним вариантом — просто ничего не найдём для
// конкретного товара, и фронт молча оставит статичный priceLabel из
// каталога (см. applyLivePrices в public/index.html) — сайт не сломается,
// в худшем случае цена останется прежней справочной.
//
// Результат кешируется на CACHE_TTL_SECONDS (см. lib/priceCache.js), чтобы
// не дёргать Digiseller на каждый заход и не зависеть от их доступности.

const express = require('express');
const router = express.Router();
const { getCache, setCache } = require('../lib/priceCache');

const CACHE_KEY = 'digiseller_prices_v1';
const CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 часов — компромисс между свежестью и тем, чтобы не дёргать Digiseller слишком часто

// id_d товаров, для которых показываем "от X ₽" на карточках каталога
// (см. digiselerProductId у соответствующих позиций catalog в
// public/index.html) — держите в синхроне при добавлении/удалении
// партнёрского товара
const PRODUCT_IDS = [5933050, 4677311, 4023986, 4362367, 3427397];

router.get('/api/prices', async (req, res) => {
  try {
    const cached = await getCache(CACHE_KEY);
    if (cached) return res.json(cached);
  } catch (e) {
    console.error('prices cache read error:', e);
  }

  try {
    const fresh = await fetchDigisellerPrices(PRODUCT_IDS);
    if (Object.keys(fresh).length > 0) {
      try { await setCache(CACHE_KEY, fresh, CACHE_TTL_SECONDS); } catch (e) { console.error('prices cache write error:', e); }
      return res.json(fresh);
    }
  } catch (e) {
    console.error('digiseller price fetch error:', e);
  }

  // не получилось ни из кеша, ни свежим запросом — отдаём пустой объект;
  // фронт в этом случае просто оставляет статичные priceLabel из каталога
  res.json({});
});

// сама цена в ответе Digiseller встречается под разными именами в
// зависимости от метода — проверяем по очереди, а не полагаемся на одно
function extractPrice(item) {
  const candidates = [item.price_rub, item.price, item.base_price, item.common_price_rur];
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// ответ мог прийти как массив напрямую, либо обёрнутым в { product: [...] }
// / { products: [...] } (так делают другие методы каталога Digiseller)
function extractItems(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.product)) return data.product;
  if (Array.isArray(data.products)) return data.products;
  return [];
}

async function fetchDigisellerPrices(ids) {
  const url = `https://api.digiseller.com/api/products/list?ids=${ids.join(',')}&lang=ru-RU&currency=RUR&format=json`;
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error('digiseller responded ' + resp.status);
  const data = await resp.json();
  const items = extractItems(data);
  const result = {};
  for (const item of items) {
    const id = Number(item.id || item.product_id);
    const price = extractPrice(item);
    if (id && price) result[id] = Math.round(price);
  }
  return result;
}

module.exports = router;
