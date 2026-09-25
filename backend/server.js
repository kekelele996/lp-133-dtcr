const { createApp } = require('./src/app');
const env = require('./src/config/env');
const messages = require('./src/constants/messages');
const logger = require('./src/utils/logger');
const ensureSchema = require('./src/utils/ensureSchema');

const start = async () => {
  // 启动时幂等升级已有数据库表结构（兑换幂等键、撤销状态）
  // 数据库暂不可用时不阻断启动（init-db.js / init.sql 同样包含新结构）
  try {
    await ensureSchema();
  } catch (err) {
    logger.error('兑换记录表结构升级跳过，服务仍将启动:', err.message);
  }

  const app = createApp();

  app.listen(env.port, () => {
    logger.info(`${messages.server.started}，端口: ${env.port}`);
  });
};

start().catch((err) => {
  logger.error('服务启动失败:', err.stack || err.message || err);
  process.exit(1);
});
