// routes/antilopayWebhook.js
const express = require('express');
const router = express.Router();
const { verifyCallback } = require('../lib/antilopay');
const store = require('../lib/store');

// Публичный ключ выдаётся Antilopay отдельно для каждого подтверждённого
// Проекта (не путать с приватным ключом для подписи ИСХОДЯЩИХ запросов!).
const PUBLIC_KEY = process.env.ANTILOPAY_PUBLIC_KEY;

// URL этого роута должен быть прописан в настройках Проекта в ЛК Antilopay
// как адрес приёма Callback: https://<ваш-домен>/antilopay-webhook

router.post('/antilopay-webhook', async (req, res) => {
  const signature = req.headers['x-apay-callback'];
  const signVersion = req.headers['x-apay-callback-version'];
  const bodyString = req.rawBody;

  if (signVersion && signVersion !== '1') {
    console.warn(`antilopay-webhook: неизвестная версия подписи ${signVersion}`);
  }

  const valid = verifyCallback(bodyString, signature, PUBLIC_KEY);
  if (!valid) {
    console.warn('antilopay-webhook: неверная подпись Callback', {
      requestId: req.headers['x-apay-request-id'],
    });
    // Отвечаем 200, чтобы не спровоцировать бессмысленные повторные отправки
    // от Antilopay, но данные с невалидной подписью не обрабатываем.
    return res.status(200).json({ status: 'ok' });
  }

  const payload = req.body || {};

  try {
    switch (payload.type) {
      case 'topup':
        await handleSteamTopupCallback(payload);
        break;
      case 'payment':
        await handlePaymentCallback(payload);
        break;
      case 'withdraw':
      case 'refund':
        // В проекте пока не используется, но логируем на будущее.
        console.log(`antilopay-webhook: callback типа "${payload.type}" без обработчика`, payload);
        break;
      default:
        console.warn('antilopay-webhook: неизвестный тип callback', payload.type);
    }
  } catch (e) {
    console.error('antilopay-webhook: ошибка обработки callback', e);
    // Всё равно отвечаем 200 — Antilopay не должен ретраить из-за наших
    // внутренних ошибок. Если что-то не так, статус всегда можно
    // перепроверить вручную через steam/topup/check или payment/check.
  }

  return res.status(200).json({ status: 'ok' });
});

async function handleSteamTopupCallback(payload) {
  const { order_id, topup_id, status, amount_paid, topup_amount, steam_account } = payload;
  if (!order_id) {
    console.warn('antilopay-webhook: topup callback без order_id', payload);
    return;
  }

  await store.updateOrderStatus(order_id, status, payload);

  if (status === 'SUCCESS') {
    // Само пополнение Steam-аккаунта на этом этапе Antilopay уже выполнил —
    // здесь остаётся только зафиксировать успех у себя и, при необходимости,
    // уведомить покупателя (например, отправить сообщение в Telegram-боте).
    console.log(
      `Steam topup ${order_id} (${topup_id}) успешно завершён: оплачено ${amount_paid} RUB, ` +
      `на аккаунт ${steam_account} зачислено ${topup_amount} RUB`
    );
    // TODO: уведомление пользователя (например, через Telegram Bot API)
  } else if (status === 'FAIL' || status === 'CANCEL' || status === 'EXPIRED') {
    console.log(`Steam topup ${order_id} завершился без успеха, статус: ${status}`);
    // TODO: при необходимости — уведомление пользователя о неудаче
  } else {
    console.log(`Steam topup ${order_id} статус обновлён на ${status}`);
  }
}

async function handlePaymentCallback(payload) {
  const { order_id, status, original_amount } = payload;
  if (!order_id) {
    console.warn('antilopay-webhook: payment callback без order_id', payload);
    return;
  }

  // Согласно документации Antilopay, обязательна проверка original_amount —
  // при расхождении с ожидаемой суммой заказа нужно отправить reverse/create.
  const order = await store.getOrder(order_id);
  if (order && order.amount != null && Number(original_amount) !== Number(order.amount)) {
    console.error(
      `antilopay-webhook: расхождение суммы платежа по заказу ${order_id}: ` +
      `ожидали ${order.amount}, пришло ${original_amount}. Требуется reverse/create.`
    );
    // TODO: вызвать reverse/create через apiPost, если это ваш кейс
  }

  await store.updateOrderStatus(order_id, status, payload);
}

module.exports = router;
