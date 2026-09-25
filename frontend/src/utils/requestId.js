// 生成一次兑换操作的幂等键：同一次点击即使因网络重试到达两次，
// 后端也只生成一笔兑换记录
export const createRequestId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `ex-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
