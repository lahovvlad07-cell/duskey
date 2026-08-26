// server.js — только для локальной разработки.
// На Vercel используется api/index.js, который экспортирует app как
// serverless-функцию (Vercel сам управляет прослушиванием порта).
const app = require('./app');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Duskey запущен: http://localhost:${PORT}`));
