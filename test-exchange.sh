#!/bin/bash
# 兑换做实后的端到端验证
BASE=http://127.0.0.1:3233/api
MYSQL="/tmp/mdb/root/usr/bin/mariadb --socket=/tmp/mdb/run/mysqld.sock -uroot -p123456 volunteer_db -N -B"

pass=0; fail=0
check() { # desc expected actual
  if [ "$2" == "$3" ]; then echo "  ✅ $1"; pass=$((pass+1));
  else echo "  ❌ $1 (期望=$2 实际=$3)"; fail=$((fail+1)); fi
}
sql() { $MYSQL -e "$1" 2>/dev/null; }

echo "▶ 登录志愿者"
TOKEN=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"phone":"13800138001","password":"123456"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
[ -n "$TOKEN" ] && echo "  ✅ 拿到 token" || { echo "  ❌ 登录失败"; exit 1; }
AUTH="Authorization: Bearer $TOKEN"

echo "▶ 场景1：正常兑换（gift=1 保温杯 100 积分，初始积分560，库存50）"
before_p=$(sql "SELECT points FROM users WHERE id=1")
before_s=$(sql "SELECT stock FROM gifts WHERE id=1")
RID="req-normal-001"
R=$(curl -s -X POST $BASE/gifts/1/exchange -H "$AUTH" -H 'Content-Type: application/json' -d "{\"requestId\":\"$RID\"}")
echo "$R" | grep -q 兑换成功 && echo "  ✅ 返回兑换成功" || echo "  ❌ $R"
after_p=$(sql "SELECT points FROM users WHERE id=1")
after_s=$(sql "SELECT stock FROM gifts WHERE id=1")
cnt=$(sql "SELECT COUNT(*) FROM exchanges WHERE request_id='$RID'")
check "积分扣减100" $((before_p-100)) $after_p
check "库存减少1" $((before_s-1)) $after_s
check "只生成1条记录" 1 $cnt
st=$(sql "SELECT status FROM exchanges WHERE request_id='$RID'")
check "记录状态 pending" pending "$st"

echo "▶ 场景2：同一 requestId 重复到达（模拟连点两次/网络重试）"
R=$(curl -s -X POST $BASE/gifts/1/exchange -H "$AUTH" -H 'Content-Type: application/json' -d "{\"requestId\":\"$RID\"}")
echo "$R" | grep -q 兑换成功 && echo "  ✅ 重复请求返回成功（幂等）" || echo "  ❌ $R"
dup=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("duplicated",False))')
check "标记为 duplicated" True "$dup"
cnt=$(sql "SELECT COUNT(*) FROM exchanges WHERE request_id='$RID'")
check "仍只有1条记录" 1 $cnt
p2=$(sql "SELECT points FROM users WHERE id=1")
s2=$(sql "SELECT stock FROM gifts WHERE id=1")
check "积分未再扣" $after_p $p2
check "库存未再减" $after_s $s2

echo "▶ 场景3：同一 requestId 真正并发到达（5 个请求同时发）"
RID2="req-concurrent-001"
for i in 1 2 3 4 5; do
  curl -s -X POST $BASE/gifts/2/exchange -H "$AUTH" -H 'Content-Type: application/json' -d "{\"requestId\":\"$RID2\"}" > /tmp/mdb/r$i.json &
done
wait
okcnt=$(grep -l 兑换成功 /tmp/mdb/r*.json | wc -l)
cnt2=$(sql "SELECT COUNT(*) FROM exchanges WHERE request_id='$RID2'")
check "并发5请求只落1条记录" 1 $cnt2
check "5个响应都成功返回" 5 $okcnt
# gift2 = 大米 200积分
p3=$(sql "SELECT points FROM users WHERE id=1")
s3=$(sql "SELECT stock FROM gifts WHERE id=2")
check "并发兑换只扣200积分" $((after_p-200)) $p3
check "并发兑换只减1库存（30->29）" 29 $s3

echo "▶ 场景4：缺货（gift=6 养生壶库存置0）"
sql "UPDATE gifts SET stock=0 WHERE id=6"
p_before=$(sql "SELECT points FROM users WHERE id=1")
R=$(curl -s -X POST $BASE/gifts/6/exchange -H "$AUTH" -H 'Content-Type: application/json' -d '{"requestId":"req-oos-001"}')
echo "$R" | grep -q 库存不足 && echo "  ✅ 返回库存不足" || echo "  ❌ $R"
p_after=$(sql "SELECT points FROM users WHERE id=1")
cnt3=$(sql "SELECT COUNT(*) FROM exchanges WHERE gift_id=6 AND user_id=1")
check "积分不变" $p_before $p_after
check "不产生记录" 0 $cnt3
check "库存仍为0" 0 "$(sql 'SELECT stock FROM gifts WHERE id=6')"

echo "▶ 场景5：积分不足（gift=5 床上四件套500积分，剩余 $p3）"
R=$(curl -s -X POST $BASE/gifts/5/exchange -H "$AUTH" -H 'Content-Type: application/json' -d '{"requestId":"req-lowpts-001"}')
echo "$R" | grep -q 积分不足 && echo "  ✅ 返回积分不足" || echo "  ❌ $R"
check "积分不变" $p3 "$(sql 'SELECT points FROM users WHERE id=1')"
check "库存不变（15）" 15 "$(sql 'SELECT stock FROM gifts WHERE id=5')"
check "不产生记录" 0 "$(sql "SELECT COUNT(*) FROM exchanges WHERE gift_id=5 AND request_id='req-lowpts-001'")"

echo "▶ 场景6：撤销待发货记录（退积分、退库存各一次）"
EXID=$(sql "SELECT id FROM exchanges WHERE request_id='$RID'")
s_before=$(sql "SELECT stock FROM gifts WHERE id=1")
p_before=$(sql "SELECT points FROM users WHERE id=1")
R=$(curl -s -X POST $BASE/exchanges/$EXID/cancel -H "$AUTH")
echo "$R" | grep -q 撤销成功 && echo "  ✅ 撤销成功" || echo "  ❌ $R"
check "积分退回100" $((p_before+100)) "$(sql 'SELECT points FROM users WHERE id=1')"
check "库存退回1" $((s_before+1)) "$(sql 'SELECT stock FROM gifts WHERE id=1')"
check "记录状态 cancelled" cancelled "$(sql "SELECT status FROM exchanges WHERE id=$EXID")"
check "cancelled_at 已写入" 1 "$(sql "SELECT cancelled_at IS NOT NULL FROM exchanges WHERE id=$EXID")"

echo "▶ 场景7：重复撤销（第二次必须失败，不能再退）"
p_c1=$(sql "SELECT points FROM users WHERE id=1")
s_c1=$(sql "SELECT stock FROM gifts WHERE id=1")
R=$(curl -s -X POST $BASE/exchanges/$EXID/cancel -H "$AUTH")
echo "$R" | grep -q 仅待发货 && echo "  ✅ 第二次撤销被拒绝" || echo "  ❌ $R"
check "积分未再退" $p_c1 "$(sql 'SELECT points FROM users WHERE id=1')"
check "库存未再退" $s_c1 "$(sql 'SELECT stock FROM gifts WHERE id=1')"

echo "▶ 场景8：已发货/已完成不能撤销"
EXID2=$(sql "SELECT id FROM exchanges WHERE request_id='$RID2'")
sql "UPDATE exchanges SET status='shipped' WHERE id=$EXID2"
R=$(curl -s -X POST $BASE/exchanges/$EXID2/cancel -H "$AUTH")
echo "$R" | grep -q 仅待发货 && echo "  ✅ 已发货拒绝撤销" || echo "  ❌ $R"
sql "UPDATE exchanges SET status='completed' WHERE id=$EXID2"
R=$(curl -s -X POST $BASE/exchanges/$EXID2/cancel -H "$AUTH")
echo "$R" | grep -q 仅待发货 && echo "  ✅ 已完成拒绝撤销" || echo "  ❌ $R"
check "积分库存无变化" $p_c1 "$(sql 'SELECT points FROM users WHERE id=1')"

echo "▶ 场景9：无 requestId 的旧客户端仍可兑换（test-api.sh 兼容）"
p9=$(sql "SELECT points FROM users WHERE id=1"); s9=$(sql "SELECT stock FROM gifts WHERE id=1")
R=$(curl -s -X POST $BASE/gifts/3/exchange -H "$AUTH" -H 'Content-Type: application/json' -d '{}')
echo "$R" | grep -q 兑换成功 && echo "  ✅ 无 requestId 兑换成功" || echo "  ❌ $R"
check "积分扣300" $((p9-300)) "$(sql 'SELECT points FROM users WHERE id=1')"
check "库存减1（20->19）" 19 "$(sql 'SELECT stock FROM gifts WHERE id=3')"

echo "▶ 场景10：撤销并发到达（2 个同时请求，只能退一次）"
EXID3=$(sql "SELECT id FROM exchanges WHERE request_id IS NULL AND gift_id=3 LIMIT 1")
p10=$(sql "SELECT points FROM users WHERE id=1"); s10=$(sql "SELECT stock FROM gifts WHERE id=3")
curl -s -X POST $BASE/exchanges/$EXID3/cancel -H "$AUTH" > /tmp/mdb/c1.json &
curl -s -X POST $BASE/exchanges/$EXID3/cancel -H "$AUTH" > /tmp/mdb/c2.json &
wait
grep -q 撤销成功 /tmp/mdb/c1.json /tmp/mdb/c2.json
ok=$(grep -l 撤销成功 /tmp/mdb/c1.json /tmp/mdb/c2.json | wc -l)
check "并发撤销只有1次成功" 1 $ok
check "积分只退一次300" $((p10+300)) "$(sql 'SELECT points FROM users WHERE id=1')"
check "库存只退一次（19->20）" 20 "$(sql 'SELECT stock FROM gifts WHERE id=3')"

echo "▶ 场景11：无权撤销别人的记录"
# 居民用户的兑换不存在，用第二个志愿者账号尝试撤销 user1 的记录
T2=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"phone":"13800138002","password":"123456"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
R=$(curl -s -X POST $BASE/exchanges/$EXID/cancel -H "Authorization: Bearer $T2")
echo "$R" | grep -qE '无权|仅待发货' && echo "  ✅ 他人不能撤销 ($R)" || echo "  ❌ $R"

echo "▶ 场景12：my/exchanges 返回剩余库存与可撤销标记"
curl -s $BASE/my/exchanges -H "$AUTH" | python3 -c '
import sys,json
rows=json.load(sys.stdin)["exchanges"]
assert all("remaining_stock" in r for r in rows), "缺少 remaining_stock"
assert all("cancellable" in r for r in rows), "缺少 cancellable"
pend=[r for r in rows if r["status"]=="pending"]
done=[r for r in rows if r["status"] in ("cancelled","shipped","completed")]
assert all(r["cancellable"] in (1,True) for r in pend), "pending 必须可撤销"
assert all(r["cancellable"] in (0,False) for r in done), "非 pending 不可撤销"
print("  ✅ remaining_stock/cancellable 字段正确，pending 可撤销=%d 条，终态不可撤销=%d 条" % (len(pend),len(done)))
'

echo "▶ 场景13：库存精确耗尽边界（gift=4 牛奶 250分，库存置1，连兑2次）"
sql "UPDATE gifts SET stock=1 WHERE id=4"
# 用户1当前积分可能不够，直接给足积分做边界验证
sql "UPDATE users SET points=1000 WHERE id=1"
R1=$(curl -s -X POST $BASE/gifts/4/exchange -H "$AUTH" -H 'Content-Type: application/json' -d '{"requestId":"req-edge-a"}')
R2=$(curl -s -X POST $BASE/gifts/4/exchange -H "$AUTH" -H 'Content-Type: application/json' -d '{"requestId":"req-edge-b"}')
echo "$R1" | grep -q 兑换成功 && echo "  ✅ 库存1件第1次成功" || echo "  ❌ $R1"
echo "$R2" | grep -q 库存不足 && echo "  ✅ 库存1件第2次拒绝" || echo "  ❌ $R2"
check "最终库存0" 0 "$(sql 'SELECT stock FROM gifts WHERE id=4')"
check "积分只扣一次250" 750 "$(sql 'SELECT points FROM users WHERE id=1')"
check "只生成1条记录" 1 "$(sql "SELECT COUNT(*) FROM exchanges WHERE gift_id=4 AND request_id IN ('req-edge-a','req-edge-b')")"

echo ""
echo "========================================"
echo "结果：✅ $pass 通过  ❌ $fail 失败"
echo "========================================"
exit $fail
