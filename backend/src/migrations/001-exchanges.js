const pool = require('../../db');
const logger = require('../utils/logger');

// 让旧库的 exchanges 表具备「幂等键 + 可撤销状态」能力。
// 每条语句都可重复执行，已存在时跳过，不影响已有数据。
const migrations = [
  `ALTER TABLE exchanges
     MODIFY COLUMN status ENUM('pending', 'shipped', 'completed', 'cancelled')
     NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE exchanges
     ADD COLUMN request_id VARCHAR(64) NULL COMMENT '幂等请求ID' AFTER points`,
  `ALTER TABLE exchanges
     ADD COLUMN cancelled_at DATETIME NULL COMMENT '撤销时间' AFTER status`,
  `ALTER TABLE exchanges
     ADD UNIQUE INDEX uk_user_request (user_id, request_id)`,
];

const columnExists = async (columnName) => {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exchanges' AND COLUMN_NAME = ?`,
    [columnName],
  );
  return rows.length > 0;
};

const indexExists = async (indexName) => {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exchanges' AND INDEX_NAME = ?`,
    [indexName],
  );
  return rows.length > 0;
};

const migrateExchanges = async () => {
  const hasRequestId = await columnExists('request_id');
  const hasCancelledAt = await columnExists('cancelled_at');

  // 状态枚举始终刷新为包含 cancelled 的版本
  await pool.query(migrations[0]);

  if (!hasRequestId) {
    await pool.query(migrations[1]);
  }

  if (!hasCancelledAt) {
    await pool.query(migrations[2]);
  }

  if (!(await indexExists('uk_user_request'))) {
    await pool.query(migrations[3]);
  }

  logger.info('兑换记录表迁移检查完成');
};

module.exports = {
  migrateExchanges,
};
