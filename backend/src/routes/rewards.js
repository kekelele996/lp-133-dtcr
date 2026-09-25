const { Router } = require('express');
const pool = require('../../db');
const messages = require('../constants/messages');
const { authenticateToken } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

router.get('/users/ranking', asyncHandler(async (req, res) => {
  const [rows] = await pool.query("SELECT id, name, service_hours, points FROM users WHERE role = 'volunteer' ORDER BY points DESC LIMIT 20");
  res.json({ ranking: rows });
}));

router.get('/gifts', asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM gifts ORDER BY points_required');
  res.json({ gifts: rows });
}));

// 生成兑换结果附带的记录信息
const buildExchangeResult = (exchange) => ({
  id: exchange.id,
  giftId: exchange.gift_id,
  points: exchange.points,
  status: exchange.status,
  requestId: exchange.request_id || null,
});

// 兑换：同一事务内核对积分与库存，再一起扣积分、减库存、写记录
// 通过 request_id（幂等键）保证重复请求不会产生第二笔记录，积分与库存不发生变化
router.post('/gifts/:id/exchange', authenticateToken, asyncHandler(async (req, res) => {
  const giftId = Number(req.params.id);
  const requestId = String(req.body?.requestId || req.headers['x-request-id'] || '').trim().slice(0, 64);

  // 幂等键缺失时由服务端补齐，保证接口向后兼容
  const idempotencyKey = requestId || `srv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // 锁定礼品行，避免超卖
    const [gifts] = await conn.query('SELECT * FROM gifts WHERE id = ? FOR UPDATE', [giftId]);
    if (gifts.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: messages.rewards.giftNotFound });
    }

    const gift = gifts[0];
    if (!gift.is_active) {
      await conn.rollback();
      return res.status(400).json({ message: messages.rewards.giftUnavailable });
    }

    // 库存为零直接失败，库存与积分均不变
    if (gift.stock <= 0) {
      await conn.rollback();
      return res.status(400).json({ message: messages.rewards.outOfStock });
    }

    // 锁定用户行，同时核对积分
    const [users] = await conn.query('SELECT points FROM users WHERE id = ? FOR UPDATE', [req.user.id]);
    if (users.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: messages.rewards.userNotFound });
    }

    if (users[0].points < gift.points_required) {
      await conn.rollback();
      return res.status(400).json({ message: messages.rewards.insufficientPoints });
    }

    // 重复请求：同一用户、同一幂等键已有记录时，原记录、积分、库存均不变，直接返回原记录
    if (requestId) {
      const [existing] = await conn.query(
        'SELECT * FROM exchanges WHERE user_id = ? AND request_id = ? LIMIT 1',
        [req.user.id, requestId],
      );
      if (existing.length > 0) {
        await conn.commit();
        return res.json({
          message: messages.rewards.exchanged,
          duplicated: true,
          exchange: buildExchangeResult(existing[0]),
        });
      }
    }

    // 条件扣减库存，affectedRows 为 0 说明已被抢光
    const [stockResult] = await conn.query(
      'UPDATE gifts SET stock = stock - 1 WHERE id = ? AND stock > 0',
      [giftId],
    );
    if (stockResult.affectedRows !== 1) {
      await conn.rollback();
      return res.status(400).json({ message: messages.rewards.outOfStock });
    }

    // 条件扣减积分，affectedRows 为 0 说明积分不足
    const [pointsResult] = await conn.query(
      'UPDATE users SET points = points - ? WHERE id = ? AND points >= ?',
      [gift.points_required, req.user.id, gift.points_required],
    );
    if (pointsResult.affectedRows !== 1) {
      await conn.rollback();
      return res.status(400).json({ message: messages.rewards.insufficientPoints });
    }

    let insertResult;
    try {
      insertResult = await conn.query(
        'INSERT INTO exchanges (user_id, gift_id, points, request_id) VALUES (?, ?, ?, ?)',
        [req.user.id, giftId, gift.points_required, idempotencyKey],
      );
    } catch (err) {
      // 并发下唯一索引兜底重复请求：回滚本次全部改动，返回已存在的原记录
      await conn.rollback();
      if (err.code === 'ER_DUP_ENTRY' && requestId) {
        const [dupes] = await pool.query(
          'SELECT * FROM exchanges WHERE user_id = ? AND request_id = ? LIMIT 1',
          [req.user.id, requestId],
        );
        if (dupes.length > 0) {
          return res.json({
            message: messages.rewards.exchanged,
            duplicated: true,
            exchange: buildExchangeResult(dupes[0]),
          });
        }
        return res.status(409).json({ message: messages.rewards.duplicateRequest });
      }
      throw err;
    }

    await conn.commit();

    res.json({
      message: messages.rewards.exchanged,
      exchange: {
        id: insertResult[0].insertId,
        giftId,
        points: gift.points_required,
        status: 'pending',
        requestId: idempotencyKey,
      },
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

// 撤销兑换：仅本人、仅待发货状态可撤销；积分与库存各退回一次
router.post('/exchanges/:id/cancel', authenticateToken, asyncHandler(async (req, res) => {
  const exchangeId = Number(req.params.id);
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // 锁定兑换记录
    const [exchanges] = await conn.query('SELECT * FROM exchanges WHERE id = ? FOR UPDATE', [exchangeId]);
    if (exchanges.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: messages.rewards.exchangeNotFound });
    }

    const exchange = exchanges[0];
    if (exchange.user_id !== req.user.id) {
      await conn.rollback();
      return res.status(403).json({ message: messages.rewards.cancelForbidden });
    }

    // 已发货或已完成不能撤销；已撤销的记录同样不能再次撤销
    if (exchange.status !== 'pending') {
      await conn.rollback();
      return res.status(400).json({ message: messages.rewards.cancelNotAllowed });
    }

    // 与兑换相同的加锁顺序（礼品 -> 用户），避免并发死锁
    await conn.query('SELECT id FROM gifts WHERE id = ? FOR UPDATE', [exchange.gift_id]);
    await conn.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [exchange.user_id]);

    // 条件更新状态，防止并发下重复撤销、重复退回
    const [statusResult] = await conn.query(
      "UPDATE exchanges SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
      [exchangeId],
    );
    if (statusResult.affectedRows !== 1) {
      await conn.rollback();
      return res.status(400).json({ message: messages.rewards.cancelNotAllowed });
    }

    // 积分退回一次（按兑换时记录的积分数）
    await conn.query(
      'UPDATE users SET points = points + ? WHERE id = ?',
      [exchange.points, exchange.user_id],
    );

    // 库存退回一次
    await conn.query(
      'UPDATE gifts SET stock = stock + 1 WHERE id = ?',
      [exchange.gift_id],
    );

    await conn.commit();

    res.json({
      message: messages.rewards.cancelled,
      exchange: { id: exchange.id, status: 'cancelled' },
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

router.get('/my/exchanges', authenticateToken, asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT e.*, g.name, g.description, g.image, g.stock AS gift_stock
     FROM exchanges e
     LEFT JOIN gifts g ON e.gift_id = g.id
     WHERE e.user_id = ?
     ORDER BY e.created_at DESC`,
    [req.user.id],
  );

  // 待发货且属于本人的记录才允许撤销
  const exchanges = rows.map((row) => ({
    ...row,
    cancellable: row.status === 'pending',
  }));

  res.json({ exchanges });
}));

module.exports = router;
