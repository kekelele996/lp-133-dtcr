const pool = require('../../db');
const logger = require('../utils/logger');

// 对已有数据库做幂等升级：
// 1. exchanges.status 增加 cancelled 枚举
// 2. exchanges 增加 request_id 列（兑换请求幂等键，同一用户同一 request_id 只允许一笔）
const ensureExchangeSchema = async () => {
  // 查看 exchanges.status 当前枚举，缺少 cancelled 时扩容
  const [statusColumns] = await pool.query(
    `SELECT COLUMN_TYPE AS columnType FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exchanges' AND COLUMN_NAME = 'status'`,
  );

  if (statusColumns.length > 0 && !statusColumns[0].columnType.includes('cancelled')) {
    await pool.query(
      "ALTER TABLE exchanges MODIFY COLUMN status ENUM('pending', 'shipped', 'completed', 'cancelled') DEFAULT 'pending' COMMENT '状态'",
    );
    logger.info('兑换记录表 status 已支持 cancelled 状态');
  }

  // 缺少 request_id 列时补充幂等键
  const [requestIdColumns] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exchanges' AND COLUMN_NAME = 'request_id'`,
  );

  if (requestIdColumns.length === 0) {
    await pool.query('ALTER TABLE exchanges ADD COLUMN request_id VARCHAR(64) NULL COMMENT "兑换请求幂等键" AFTER points');
    await pool.query(
      'ALTER TABLE exchanges ADD UNIQUE KEY uk_user_request (user_id, request_id)',
    );
    logger.info('兑换记录表幂等键 request_id 已添加');
  }
};

const ensureSchema = async () => {
  try {
    await ensureExchangeSchema();
  } catch (err) {
    logger.error('兑换记录表结构升级失败:', err.message);
    throw err;
  }
};

module.exports = ensureSchema;
