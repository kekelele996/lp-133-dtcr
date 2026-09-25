const { Router } = require('express');
const pool = require('../../db');
const messages = require('../constants/messages');
const { authenticateToken } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

// MySQL 唯一键冲突错误码
const ER_DUP_ENTRY = 1062;

router.get('/users/ranking', asyncHandler(async (req, res) => {
  const [rows] = await pool.query("SELECT id, name, service_hours, points FROM users WHERE role = 'volunteer' ORDER BY points DESC LIMIT 20");
  res.json({ ranking: rows });
}));

router.get('/gifts', asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM gifts ORDER BY points_required');
  res.json({ gifts: rows });
}));

// 兑换礼品：同一事务内核对积分与库存，再一起扣积分、减库存、写记录。
// 通过 request_id 幂等键保证重复请求只产生一笔记录；
// 条件更新（points >= ? / stock > 0）保证积分和库存不会被扣成负数。
router.post('/gifts/:id/exchange', authenticateToken, asyncHandler(async (req, res) => {
  const giftId = Number(req.params.id);
  const userId = req.user.id;
  const requestId = typeof req.body.requestId === 'string' ? req.body.requestId.trim() : '';

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 幂等：同一（用户, requestId）的请求重复到达，直接返回原记录，原积分与库存不再变化
    if (requestId) {
      const [existing] = await conn.query(
        'SELECT * FROM exchanges WHERE user_id = ? AND request_id = ? LIMIT 1',
        [userId, requestId],
      );
      if (existing.length > 0) {
        await conn.commit();
        return res.json({ message: messages.rewards.exchanged, exchange: existing[0], duplicated: true });
      }
    }

    // 锁定礼品行，避免并发兑换同时读到同一库存
    const [gifts] = await conn.query('SELECT * FROM gifts WHERE id = ? FOR UPDATE', [giftId]);
    if (gifts.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: messages.rewards.giftNotFound });
    }

    const gift = gifts[0];
    if (!gift.is_active) {
      await conn.rollback();
      return res.status(400).json({ message: messages.rewards.giftOffline });
    }
    if (gift.stock <= 0) {
      await conn.rollback();
      return res.status(400).json({ message: messages.rewards.outOfStock });
    }

    // 锁定用户行后核对积分
    const [users] = await conn.query('SELECT points FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (users.length === 0 || users[0].points < gift.points_required) {
      await conn.rollback();
      return res.status(400).json({ message: messages.rewards.insufficientPoints });
    }

    // 条件式扣积分：积分不足时 affectedRows 为 0，不产生超扣
    const [pointResult] = await conn.query(
      'UPDATE users SET points = points - ? WHERE id = ? AND points >= ?',
      [gift.points_required, userId, gift.points_required],
    );
    if (pointResult.affectedRows === 0) {
      await conn.rollback();
      return res.status(400).json({ message: messages.rewards.insufficientPoints });
    }

    // 条件式减库存：库存为零时 affectedRows 为 0，绝不超卖
    const [stockResult] = await conn.query(
      'UPDATE gifts SET stock = stock - 1 WHERE id = ? AND stock > 0',
      [giftId],
    );
    if (stockResult.affectedRows === 0) {
      await conn.rollback();
      return res.status(400).json({ message: messages.rewards.outOfStock });
    }

    // 写下兑换记录（request_id 唯一索引兜底并发重复提交）
    let exchangeId;
    try {
      const [insertResult] = await conn.query(
        'INSERT INTO exchanges (user_id, gift_id, points, request_id, status) VALUES (?, ?, ?, ?, ?)',
        [userId, giftId, gift.points_required, requestId || null, 'pending'],
      );
      exchangeId = insertResult.insertId;
    } catch (err) {
      if (err.errno === ER_DUP_ENTRY) {
        // 并发的同 requestId 请求已抢先提交：回滚本次扣分减库，返回原记录
        await conn.rollback();
        const [rows] = await pool.query(
          'SELECT * FROM exchanges WHERE user_id = ? AND request_id = ? LIMIT 1',
          [userId, requestId],
        );
        return res.json({ message: messages.rewards.exchanged, exchange: rows[0], duplicated: true });
      }
      throw err;
    }

    await conn.commit();

    const [created] = await pool.query('SELECT * FROM exchanges WHERE id = ?', [exchangeId]);
    res.json({ message: messages.rewards.exchanged, exchange: created[0] });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

// 撤销待发货的兑换：同一事务内把积分与库存各退回一次，记录置为已撤销。
// 仅本人、且仍为 pending 的记录可撤销；条件更新保证并发撤销只退回一次。
router.post('/exchanges/:id/cancel', authenticateToken, asyncHandler(async (req, res) => {
  const exchangeId = Number(req.params.id);
  const userId = req.user.id;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query('SELECT * FROM exchanges WHERE id = ? FOR UPDATE', [exchangeId]);
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: messages.rewards.exchangeNotFound });
    }

    const exchange = rows[0];
    if (exchange.user_id !== userId) {
      await conn.rollback();
      return res.status(403).json({ message: messages.rewards.exchangeForbidden });
    }
    if (exchange.status !== 'pending') {
      await conn.rollback();
      return res.status(400).json({ message: messages.rewards.cannotCancel });
    }

    // 只有仍是 pending 的记录会被改为 cancelled，并发撤销时第二次 affectedRows 为 0
    const [cancelResult] = await conn.query(
      "UPDATE exchanges SET status = 'cancelled', cancelled_at = NOW() WHERE id = ? AND status = 'pending'",
      [exchangeId],
    );
    if (cancelResult.affectedRows === 0) {
      await conn.rollback();
      return res.status(400).json({ message: messages.rewards.cannotCancel });
    }

    await conn.query('UPDATE users SET points = points + ? WHERE id = ?', [exchange.points, userId]);
    await conn.query('UPDATE gifts SET stock = stock + 1 WHERE id = ?', [exchange.gift_id]);

    await conn.commit();
    res.json({ message: messages.rewards.cancelled });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

router.get('/my/exchanges', authenticateToken, asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT e.*,
            g.name, g.description, g.image,
            g.stock AS remaining_stock,
            (e.status = 'pending') AS cancellable
       FROM exchanges e
       LEFT JOIN gifts g ON e.gift_id = g.id
      WHERE e.user_id = ?
      ORDER BY e.created_at DESC`,
    [req.user.id],
  );

  res.json({ exchanges: rows });
}));

module.exports = router;
