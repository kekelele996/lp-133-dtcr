const { createApp } = require('./src/app');
const env = require('./src/config/env');
const messages = require('./src/constants/messages');
const logger = require('./src/utils/logger');
const { migrateExchanges } = require('./src/migrations/001-exchanges');

const app = createApp();

const start = async () => {
  // 旧库升级：兑换记录增加幂等键与撤销状态，失败则不启动，避免在旧表结构上误扣
  await migrateExchanges();

  app.listen(env.port, () => {
    logger.info(`${messages.server.started}，端口: ${env.port}`);
  });
};

start().catch((err) => {
  logger.error(`启动失败: ${err.message}`);
  process.exit(1);
});
