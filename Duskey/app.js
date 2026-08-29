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

function renderRedirectPage({ ok, title, heading, orderId }) {
  const safeOrderId = orderId ? String(orderId).replace(/[<>]/g, '') : '—';
  // Кнопка ведёт обратно на сайт — так было изначально и так и должно
  // оставаться: после оплаты (успешной или нет) человек возвращается на
  // сам сайт, а не куда-то в сторону.
  //
  // Ниже — вторая, самостоятельная кнопка «Закрыть окно»: страница может
  // быть открыта либо из Telegram-бота (через системный/встроенный браузер —
  // см. историю решений в openExternalPurchase в public/index.html), либо
  // обычным посетителем сайта напрямую. Серверу это неизвестно, поэтому
  // человеку просто предлагается выбор: закрыть окно и вернуться в бота,
  // или остаться и продолжить на сайте — без гадания, откуда он пришёл.
  // window.close() у большинства браузеров срабатывает только для вкладок,
  // открытых скриптом (window.open) — если это не тот случай, тихо ничего
  // не произойдёт, и через секунду показывается понятная подсказка вместо
  // того, чтобы человек тыкал в неработающую кнопку молча.
  const siteUrl = process.env.SITE_URL || '/';
  const accent = ok ? '#6c78ff' : '#ff8a68';
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding: 20px;
    font-family: 'Golos Text','Segoe UI',system-ui,sans-serif; background:#0e0f1e; color:#eef0fa; text-align:center; }
  .card { padding: 34px 28px; max-width: 380px; width: 100%; background:#171933; border:1px solid rgba(255,255,255,0.08);
    border-radius: 18px; box-shadow: 0 12px 26px -16px rgba(0,0,0,0.55); }
  .badge { width: 52px; height: 52px; margin: 0 auto 16px; border-radius: 999px; display:flex; align-items:center;
    justify-content:center; background: color-mix(in srgb, ${accent} 18%, transparent); color: ${accent}; }
  .badge svg { width: 26px; height: 26px; }
  h2 { margin: 0 0 8px; font-size: 20px; }
  p { color:#b3b8da; margin: 0 0 24px; font-size: 14px; }
  .actions { display:flex; flex-direction: column; gap: 10px; }
  .btn { display:inline-block; padding:11px 20px; border-radius:999px; text-decoration:none; font-size: 14.5px;
    font-family: inherit; cursor: pointer; border: none; }
  .btn-primary { background:${accent}; color:#12132a; font-weight: 600; }
  .btn-ghost { background: transparent; color:#eef0fa; border: 1px solid rgba(255,255,255,0.14); }
  .hint { margin-top: 18px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.08); }
  .hint p { margin: 0; font-size: 12.5px; color: #767ca4; line-height: 1.5; }
  .close-note { display:none; margin-top: 10px; font-size: 12.5px; color:#767ca4; }
  .close-note.is-visible { display:block; }
</style>
</head>
<body>
  <div class="card">
    <div class="badge">${ok
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>'}</div>
    <h2>${heading}</h2>
    <p>Номер заказа: ${safeOrderId}</p>
    <div class="actions">
      <a class="btn btn-primary" href="${siteUrl}">Продолжить на сайте</a>
      <button type="button" class="btn btn-ghost" id="closeBtn">Закрыть окно</button>
    </div>
    <div class="hint">
      <p>Пришли из Telegram-бота? «Закрыть окно» вернёт вас туда.<br>Иначе — просто продолжите на сайте.</p>
      <p class="close-note" id="closeNote">Не закрылось само — закройте вкладку вручную, чтобы вернуться в бота.</p>
    </div>
  </div>
  <script>
    document.getElementById('closeBtn').addEventListener('click', function () {
      window.close();
      // если вкладка не была открыта скриптом, window.close() тихо не
      // сработает — страница останется видимой, и через паузу стоит явно
      // подсказать, что делать дальше, а не оставлять кнопку немой
      setTimeout(function () {
        document.getElementById('closeNote').classList.add('is-visible');
      }, 400);
    });
  </script>
</body></html>`;
}

// Статика каталога — раздаём из /public. Кладём эти роуты последними,
// чтобы API-эндпоинты выше имели приоритет над одноимёнными путями.
app.use(express.static(path.join(__dirname, 'public')));

module.exports = app;
