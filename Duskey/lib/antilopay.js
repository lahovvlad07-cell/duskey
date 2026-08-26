// lib/antilopay.js
// Подпись исходящих запросов приватным ключом (SHA256withRSA) и проверка
// подписи входящих Callback'ов публичным ключом. Тело запроса ВСЕГДА
// подписывается и отправляется как одна и та же строка — без пробелов,
// без переносов, ровно так, как отдаёт JSON.stringify.

const crypto = require('crypto');

const BASE_URL = process.env.ANTILOPAY_BASE_URL || 'https://lk.antilopay.com/api/v1/';

function toPem(base64Key, label) {
  return `-----BEGIN ${label}-----\n${base64Key}\n-----END ${label}-----`;
}

function sign(bodyString, privateKeyBase64) {
  const pem = toPem(privateKeyBase64, 'RSA PRIVATE KEY');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(bodyString, 'utf8');
  return signer.sign(pem, 'base64');
}

function verifyCallback(bodyString, signatureBase64, publicKeyBase64) {
  if (!signatureBase64 || !publicKeyBase64) return false;
  const pem = toPem(publicKeyBase64, 'PUBLIC KEY');
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(bodyString, 'utf8');
  try {
    return verifier.verify(pem, signatureBase64, 'base64');
  } catch (e) {
    // ключ невалиден / формат подписи неожиданный — считаем подпись неверной
    return false;
  }
}

/**
 * Выполняет подписанный POST-запрос к Antilopay API v1.
 * @param {string} path - например "steam/topup/create"
 * @param {object} payload - тело запроса
 * @param {{secretId: string, privateKey: string}} creds
 */
async function apiPost(path, payload, { secretId, privateKey }) {
  if (!secretId || !privateKey) {
    throw new Error(
      'Antilopay: не заданы ANTILOPAY_SECRET_ID / ANTILOPAY_PRIVATE_KEY (переменные окружения)'
    );
  }

  const bodyString = JSON.stringify(payload);
  const signature = sign(bodyString, privateKey);

  const res = await fetch(BASE_URL + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Apay-Secret-Id': secretId,
      'X-Apay-Sign': signature,
      'X-Apay-Sign-Version': '1',
    },
    body: bodyString,
  });

  const requestId = res.headers.get('x-apay-request-id');
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    // некоторые эндпоинты (например steam/account/check) не возвращают тело
  }
  return { httpStatus: res.status, requestId, data };
}

/**
 * GET-запрос к Antilopay API v1 (для GET-эндпоинтов достаточно X-Apay-Secret-Id).
 */
async function apiGet(path, { secretId }) {
  if (!secretId) {
    throw new Error('Antilopay: не задан ANTILOPAY_SECRET_ID (переменная окружения)');
  }
  const res = await fetch(BASE_URL + path, {
    method: 'GET',
    headers: { 'X-Apay-Secret-Id': secretId },
  });
  const requestId = res.headers.get('x-apay-request-id');
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  return { httpStatus: res.status, requestId, data };
}

module.exports = { sign, verifyCallback, apiPost, apiGet, BASE_URL };
