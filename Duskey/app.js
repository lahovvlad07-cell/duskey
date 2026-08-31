// app.js
require('dotenv').config();
const path = require('path');
const express = require('express');
const app = express();

// ВАЖНО: подпись Callback от Antilopay проверяется по «сырому» телу запроса —
// байт-в-байт как оно пришло, без повторной JSON.stringify-сериализации.
// Поэтому сохраняем raw body в req.rawBody прямо на этапе парсинга.
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'duskey',
    storage: require('./lib/store').usingRedis ? 'upstash-redis' : 'tmp-file (dev only)',
  });
});

app.use('/', require('./routes/steamTopup'));
app.use('/', require('./routes/antilopayWebhook'));
app.use('/', require('./routes/tamagotchi'));

// Страницы редиректа после оплаты (success_url / fail_url из steamTopup.js).
app.get('/steam/success', (req, res) => {
  const { order_id } = req.query;
  res.send(renderRedirectPage({
    ok: true,
    title: 'Оплата прошла успешно',
    heading: 'Пополнение Steam выполнено ✅',
    orderId: order_id,
  }));
});

app.get('/steam/fail', (req, res) => {
  const { order_id } = req.query;
  res.send(renderRedirectPage({
    ok: false,
    title: 'Оплата не прошла',
    heading: 'Оплата не завершена ❌',
    orderId: order_id,
  }));
});

function renderRedirectPage({ title, heading, orderId }) {
  const safeOrderId = orderId ? String(orderId).replace(/[<>]/g, '') : '—';
  // Кнопка ведёт обратно на сайт — так было изначально и так и должно
  // оставаться: после оплаты (успешной или нет) человек возвращается на
  // сам сайт, а не куда-то в сторону (бот здесь ни при чём — это отдельная
  // история, не имеющая отношения к возврату со страницы оплаты).
  const siteUrl = process.env.SITE_URL || '/';
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family: 'Golos Text','Segoe UI',system-ui,sans-serif; background:#0e0f1e; color:#eef0fa; text-align:center; }
  .card { padding: 32px 28px; max-width: 380px; }
  h2 { margin: 0 0 12px; }
  p { color:#b3b8da; margin: 0 0 20px; }
  a.btn { display:inline-block; padding:10px 20px; border-radius:999px; background:#6c78ff; color:#fff; text-decoration:none; }
</style>
</head>
<body>
  <div class="card">
    <h2>${heading}</h2>
    <p>Номер заказа: ${safeOrderId}</p>
    <a class="btn" href="${siteUrl}">Вернуться на сайт</a>
  </div>
</body></html>`;
}

// Статика каталога — раздаём из /public. Кладём эти роуты последними,
// чтобы API-эндпоинты выше имели приоритет над одноимёнными путями.
app.use(express.static(path.join(__dirname, 'public')));

module.exports = app;
