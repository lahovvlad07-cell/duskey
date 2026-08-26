// api/index.js
// Vercel (сборщик @vercel/node) принимает Express-приложение как есть:
// app(req, res) уже является валидным обработчиком запроса, поэтому
// никаких дополнительных обёрток (serverless-http и т.п.) не требуется.
module.exports = require('../app');
