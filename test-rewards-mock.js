// 用内存 Mock 数据库验证兑换/撤销事务逻辑（无需 MySQL）
const Module = require('module');
const path = require('path');

// ---- 内存数据库 ----
const db = {
  users: [
    { id: 1, points: 200 },
    { id: 2, points: 50 },
  ],
  gifts: [
    { id: 1, name: '保温杯', points_required: 100, stock: 2, is_active: 1 },
    { id: 2, name: '大米', points_required: 200, stock: 0, is_active: 1 },
    { id: 3, name: '下架品', points_required: 50, stock: 10, is_active: 0 },
  ],
  exchanges: [],
};
let exchangeSeq = 1;

const applyUpdate = (sql, params) => {
  const s = sql.replace(/\s+/g, ' ');

  let m = s.match(/^UPDATE gifts SET stock = stock - 1 WHERE id = \? AND stock > 0$/);
  if (m) {
    const g = db.gifts.find((x) => x.id === params[0]);
    if (g && g.stock > 0) { g.stock -= 1; return 1; }
    return 0;
  }

  m = s.match(/^UPDATE users SET points = points - \? WHERE id = \? AND points >= \?$/);
  if (m) {
    const [pts, uid] = params;
    const u = db.users.find((x) => x.id === uid);
    if (u && u.points >= pts) { u.points -= pts; return 1; }
    return 0;
  }

  m = s.match(/^UPDATE exchanges SET status = 'cancelled' WHERE id = \? AND status = 'pending'$/);
  if (m) {
    const e = db.exchanges.find((x) => x.id === params[0]);
    if (e && e.status === 'pending') { e.status = 'cancelled'; return 1; }
    return 0;
  }

  m = s.match(/^UPDATE users SET points = points \+ \? WHERE id = \?$/);
  if (m) {
    const [pts, uid] = params;
    const u = db.users.find((x) => x.id === uid);
    u.points += pts;
    return 1;
  }

  m = s.match(/^UPDATE gifts SET stock = stock \+ 1 WHERE id = \?$/);
  if (m) {
    const g = db.gifts.find((x) => x.id === params[0]);
    g.stock += 1;
    return 1;
  }

  throw new Error(`未模拟的 UPDATE: ${s}`);
};

// 模拟一个“连接”，FOR UPDATE 在此测试中等同于普通查询
const makeConn = () => ({
  async beginTransaction() {},
  async commit() {},
  async rollback() {},
  release() {},
  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT * FROM gifts WHERE id = ? FOR UPDATE')) {
      return [db.gifts.filter((g) => g.id === params[0]).map((g) => ({ ...g }))];
    }
    if (s.startsWith('SELECT points FROM users WHERE id = ? FOR UPDATE')) {
      return [db.users.filter((u) => u.id === params[0]).map((u) => ({ ...u }))];
    }
    if (s.startsWith('SELECT id FROM gifts WHERE id = ? FOR UPDATE')) {
      return [db.gifts.filter((g) => g.id === params[0])];
    }
    if (s.startsWith('SELECT id FROM users WHERE id = ? FOR UPDATE')) {
      return [db.users.filter((u) => u.id === params[0])];
    }
    if (s.startsWith('SELECT * FROM exchanges WHERE id = ? FOR UPDATE')) {
      return [db.exchanges.filter((e) => e.id === params[0]).map((e) => ({ ...e }))];
    }
    if (s.startsWith('SELECT * FROM exchanges WHERE user_id = ? AND request_id = ?')) {
      return [db.exchanges.filter((e) => e.user_id === params[0] && e.request_id === params[1]).map((e) => ({ ...e }))];
    }
    if (s.startsWith('INSERT INTO exchanges')) {
      // 模拟唯一索引 (user_id, request_id)，request_id 非空时冲突
      const [uid, gid, pts, reqId] = params;
      if (reqId && db.exchanges.some((e) => e.user_id === uid && e.request_id === reqId)) {
        const err = new Error("Duplicate entry '1-ex_x' for key 'uk_user_request'");
        err.code = 'ER_DUP_ENTRY';
        throw err;
      }
      const id = exchangeSeq++;
      db.exchanges.push({ id, user_id: uid, gift_id: gid, points: pts, request_id: reqId, status: 'pending', created_at: new Date() });
      return [{ insertId: id }];
    }
    if (s.startsWith('UPDATE')) {
      return [{ affectedRows: applyUpdate(sql, params) }];
    }
    // /my/exchanges 的联表查询
    if (s.includes('FROM exchanges e')) {
      const rows = db.exchanges
        .filter((e) => e.user_id === params[0])
        .map((e) => {
          const g = db.gifts.find((x) => x.id === e.gift_id);
          return { ...e, name: g.name, gift_stock: g.stock };
        });
      return [rows];
    }
    throw new Error(`未模拟的 SQL: ${s}`);
  },
});

const mockPool = {
  async getConnection() { return makeConn(); },
  async query(sql, params) { return makeConn().query(sql, params); },
};

// ---- 用 mock pool 劫持 db 模块 ----
const dbPath = path.resolve(__dirname, 'backend/db.js');
const origLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (parent && parent.filename === dbPath) return origLoad.apply(this, arguments);
  if (request === '../../db' && parent && parent.filename.includes('routes')) {
    return mockPool;
  }
  return origLoad.apply(this, arguments);
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };

const router = require('./backend/src/routes/rewards');

// ---- 从 Express Router 层提取路由处理器 ----
const findHandler = (method, urlPrefix) => {
  const layer = router.stack.find(
    (l) => l.route && l.route.path.startsWith(urlPrefix) && l.route.methods[method],
  );
  if (!layer) throw new Error(`路由不存在: ${method} ${urlPrefix}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const exchangeHandler = findHandler('post', '/gifts/:id/exchange');
const cancelHandler = findHandler('post', '/exchanges/:id/cancel');
const listHandler = findHandler('get', '/my/exchanges');

// ---- 测试工具 ----
let passed = 0;
let failed = 0;
const assert = (cond, label) => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
};

const call = (handler, { userId, params = {}, body = {} }) => new Promise((resolve) => {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { resolve({ statusCode: this.statusCode, body: payload }); },
  };
  handler({ user: { id: userId }, params, body, headers: {} }, res, (err) => {
    if (err) resolve({ statusCode: 500, body: { error: err.message } });
  });
});

const snapshot = () => ({
  user1Points: db.users[0].points,
  user2Points: db.users[1].points,
  gift1Stock: db.gifts[0].stock,
  gift2Stock: db.gifts[1].stock,
  exchangeCount: db.exchanges.length,
});

const run = async () => {
  console.log('▶ 场景1：正常兑换（积分与库存同时扣减，写入记录）');
  let s0 = snapshot();
  let r = await call(exchangeHandler, { userId: 1, params: { id: 1 }, body: { requestId: 'req-1' } });
  assert(r.statusCode === 200 && r.body.message === '兑换成功', '兑换返回成功');
  assert(db.users[0].points === s0.user1Points - 100, `积分 200 -> ${db.users[0].points}`);
  assert(db.gifts[0].stock === s0.gift1Stock - 1, `库存 2 -> ${db.gifts[0].stock}`);
  assert(db.exchanges.length === s0.exchangeCount + 1, '生成 1 条 pending 记录');
  assert(db.exchanges[0].status === 'pending', '记录状态为 pending');

  console.log('▶ 场景2：相同 requestId 重复到达（连点两次）—— 原记录与库存积分不变');
  s0 = snapshot();
  r = await call(exchangeHandler, { userId: 1, params: { id: 1 }, body: { requestId: 'req-1' } });
  assert(r.statusCode === 200 && r.body.duplicated === true, '重复请求返回原记录（duplicated=true）');
  assert(db.exchanges.length === s0.exchangeCount, '记录数不变');
  assert(db.users[0].points === s0.user1Points, '积分不变');
  assert(db.gifts[0].stock === s0.gift1Stock, '库存不变');

  console.log('▶ 场景3：库存为零仍请求兑换 —— 失败且数据不变');
  s0 = snapshot();
  r = await call(exchangeHandler, { userId: 1, params: { id: 2 }, body: { requestId: 'req-oos' } });
  assert(r.statusCode === 400 && r.body.message === '礼品库存不足', `返回库存不足 (${r.body.message})`);
  assert(db.exchanges.length === s0.exchangeCount, '未生成记录');
  assert(db.users[0].points === s0.user1Points, '积分不变');
  assert(db.gifts[1].stock === 0, '库存仍为 0');

  console.log('▶ 场景4：积分不足 —— 失败且库存不变');
  s0 = snapshot();
  r = await call(exchangeHandler, { userId: 2, params: { id: 1 }, body: { requestId: 'req-poor' } });
  assert(r.statusCode === 400 && r.body.message === '积分不足', '返回积分不足');
  assert(db.exchanges.length === s0.exchangeCount, '未生成记录');
  assert(db.gifts[0].stock === s0.gift1Stock, '库存不变');
  assert(db.users[1].points === s0.user2Points, '积分不变');

  console.log('▶ 场景5：最后一件库存的边界扣减（stock=1 -> 0）');
  r = await call(exchangeHandler, { userId: 1, params: { id: 1 }, body: { requestId: 'req-last' } });
  assert(r.statusCode === 200, '库存 1 件时兑换成功');
  assert(db.gifts[0].stock === 0, '库存降为 0');
  r = await call(exchangeHandler, { userId: 1, params: { id: 1 }, body: { requestId: 'req-after-zero' } });
  assert(r.statusCode === 400 && r.body.message === '礼品库存不足', '库存 0 后再次兑换失败');

  console.log('▶ 场景6：撤销待发货记录 —— 积分库存各退回一次');
  const pendingId = db.exchanges.find((e) => e.request_id === 'req-last').id;
  s0 = snapshot();
  r = await call(cancelHandler, { userId: 1, params: { id: pendingId } });
  assert(r.statusCode === 200 && r.body.message.includes('撤销成功'), '撤销成功');
  assert(db.users[0].points === s0.user1Points + 100, '积分退回 100');
  assert(db.gifts[0].stock === s0.gift1Stock + 1, '库存退回 1（0 -> 1）');
  assert(db.exchanges.find((e) => e.id === pendingId).status === 'cancelled', '记录变为 cancelled');

  console.log('▶ 场景7：重复撤销 —— 不二次退回');
  s0 = snapshot();
  r = await call(cancelHandler, { userId: 1, params: { id: pendingId } });
  assert(r.statusCode === 400 && r.body.message === '已发货或已完成的兑换不能撤销', '重复撤销被拒绝');
  assert(db.users[0].points === s0.user1Points, '积分不再变化');
  assert(db.gifts[0].stock === s0.gift1Stock, '库存不再变化');

  console.log('▶ 场景8：他人撤销 —— 无权限且不变');
  const otherId = db.exchanges.find((e) => e.request_id === 'req-1').id;
  s0 = snapshot();
  r = await call(cancelHandler, { userId: 2, params: { id: otherId } });
  assert(r.statusCode === 403 && r.body.message === '无权限撤销该兑换记录', '返回无权限');
  assert(db.users[0].points === s0.user1Points && db.users[1].points === s0.user2Points, '双方积分不变');

  console.log('▶ 场景9：已发货记录不可撤销');
  const shipped = db.exchanges.find((e) => e.request_id === 'req-1');
  shipped.status = 'shipped';
  s0 = snapshot();
  r = await call(cancelHandler, { userId: 1, params: { id: shipped.id } });
  assert(r.statusCode === 400 && r.body.message === '已发货或已完成的兑换不能撤销', '已发货不能撤销');
  assert(db.users[0].points === s0.user1Points, '积分不变');
  assert(db.gifts[0].stock === s0.gift1Stock, '库存不变');

  console.log('▶ 场景10：记录列表含剩余库存与可撤销标记');
  const listRes = await call(listHandler, { userId: 1 });
  assert(listRes.statusCode === 200, '查询成功');
  const rows = listRes.body.exchanges;
  assert(rows.every((e) => typeof e.gift_stock === 'number'), '每条记录带剩余库存 gift_stock');
  assert(rows.every((e) => e.cancellable === (e.status === 'pending')), 'cancellable 仅在 pending 时为 true');

  console.log(`\n结果：${passed} 通过, ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
};

run().catch((err) => { console.error(err); process.exit(1); });
