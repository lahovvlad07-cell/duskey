// routes/steamTopup.js
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { apiPost } = require('../lib/antilopay');
const store = require('../lib/store');

const PROJECT_ID = process.env.ANTILOPAY_PROJECT_ID;
const SECRET_ID = process.env.ANTILOPAY_SECRET_ID;
const PRIVATE_KEY = process.env.ANTILOPAY_PRIVATE_KEY;
const SITE_URL = process.env.SITE_URL || 'https://example.com';

// Префикс DSK — по нему потом легко фильтровать свои заказы при выгрузке
// из личного кабинета Antilopay (order_id всегда присутствует в выгрузке).
function genOrderId() {
  const rand = crypto.randomBytes(3).toString('hex');
  return `DSK-${Date.now()}-${rand}`;
}

function creds() {
  return { secretId: SECRET_ID, privateKey: PRIVATE_KEY };
}

// 1. Проверка Steam-логина перед показом формы оплаты (необязательный, но
//    рекомендуемый шаг — отсекает опечатки и недоступные регионы заранее).
router.post('/steam/check-account', async (req, res) => {
  const { steam_account } = req.body || {};
  if (!steam_account) {
    return res.status(400).json({ ok: false, error: 'Не указан steam_account' });
  }

  try {
    const { httpStatus } = await apiPost(
      'steam/account/check',
      { project_identificator: PROJECT_ID, steam_account },
      creds()
    );

    if (httpStatus === 200) return res.json({ ok: true });
    if (httpStatus === 404) {
      return res.status(404).json({ ok: false, error: 'Аккаунт не найден или недоступен для пополнения' });
    }
    return res.status(502).json({ ok: false, error: 'Не удалось проверить аккаунт, попробуйте позже' });
  } catch (e) {
    console.error('steam/account/check error:', e);
    return res.status(502).json({ ok: false, error: 'Сервис временно недоступен' });
  }
});

// 2. Создание пополнения. Сумма оплаты и сумма пополнения указаны отдельно —
//    если хотите брать комиссию/наценку сверху, считайте amount здесь, а не
//    на фронте (чтобы человек не мог подменить сумму оплаты в браузере).
router.post('/steam/create', async (req, res) => {
  const { steam_account, topup_amount, email, phone } = req.body || {};

  const topupAmountNum = Number(topup_amount);
  if (!steam_account || !topupAmountNum || topupAmountNum <= 0) {
    return res.status(400).json({ ok: false, error: 'Укажите steam_account и корректную сумму' });
  }
  if (!email && !phone) {
    return res.status(400).json({ ok: false, error: 'Укажите email или телефон для чека/связи' });
  }

  const order_id = genOrderId();
  const amount = topupAmountNum; // без наценки; поменяйте формулу при необходимости

  const payload = {
    project_identificator: PROJECT_ID,
    amount,
    topup_amount: topupAmountNum,
    order_id,
    currency: 'RUB',
    steam_account,
    description: `Пополнение Steam ${steam_account} на ${topupAmountNum} RUB`,
    success_url: `${SITE_URL}/steam/success?order_id=${order_id}`,
    fail_url: `${SITE_URL}/steam/fail?order_id=${order_id}`,
    customer: {
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      ip: req.ip,
    },
  };

  try {
    const { data } = await apiPost('steam/topup/create', payload, creds());

    if (!data || data.code !== 0) {
      return res.status(502).json({
        ok: false,
        error: data?.error || 'Antilopay вернул ошибку',
        code: data?.code,
      });
    }

    await store.saveOrder({
      order_id,
      topup_id: data.topup_id,
      steam_account,
      topup_amount: topupAmountNum,
      amount,
      status: 'PENDING',
      created_at: new Date().toISOString(),
    });

    res.json({ ok: true, order_id, payment_url: data.payment_url });
  } catch (e) {
    console.error('steam/topup/create error:', e);
    res.status(502).json({ ok: false, error: 'Сервис временно недоступен' });
  }
});

// 3. Статус заказа — для поллинга со страницы success/fail, если Callback
//    ещё не успел дойти в момент, когда покупатель вернулся на сайт.
router.get('/steam/status/:order_id', async (req, res) => {
  const order = await store.getOrder(req.params.order_id);
  if (!order) return res.status(404).json({ ok: false });
  res.json({ ok: true, order });
});

module.exports = router;
