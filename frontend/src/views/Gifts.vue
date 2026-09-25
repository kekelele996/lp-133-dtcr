<template>
  <div class="min-h-screen bg-gray-50">
    <div class="container mx-auto px-4 py-6">
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-2xl font-bold text-gray-800">积分兑换</h1>
        <div class="flex items-center text-green-600 font-medium">
          <el-icon class="mr-2"><Coin /></el-icon>
          当前积分：{{ user?.points || 0 }}
        </div>
      </div>

      <el-tabs v-model="activeTab" class="mb-6">
        <el-tab-pane label="礼品中心" name="gifts" />
        <el-tab-pane label="兑换记录" name="exchanges" />
      </el-tabs>

      <div v-if="activeTab === 'gifts'">
        <div v-if="loading" class="text-center py-16">
          <el-icon class="animate-spin text-4xl text-gray-400"><Loading /></el-icon>
        </div>

        <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          <el-card v-for="gift in gifts" :key="gift.id" class="hover:shadow-lg transition-shadow">
            <img :src="gift.image" :alt="gift.name" class="w-full h-48 object-cover rounded-lg mb-4" />
            <h3 class="font-medium text-lg mb-2">{{ gift.name }}</h3>
            <p class="text-sm text-gray-500 mb-2 line-clamp-2">{{ gift.description }}</p>
            <p class="text-sm mb-4" :class="gift.stock > 0 ? 'text-gray-500' : 'text-red-500 font-medium'">
              剩余库存：{{ gift.stock }}
            </p>
            <div class="flex items-center justify-between">
              <span class="text-green-600 font-bold text-lg">
                <el-icon class="mr-1"><Coin /></el-icon>
                {{ gift.points_required }}
              </span>
              <el-button
                type="primary"
                size="small"
                :loading="submittingId === gift.id"
                :disabled="!canExchange(gift)"
                @click="handleExchange(gift)"
              >
                {{ exchangeButtonText(gift) }}
              </el-button>
            </div>
          </el-card>
        </div>
      </div>

      <div v-else>
        <div v-if="exchangesLoading" class="text-center py-16">
          <el-icon class="animate-spin text-4xl text-gray-400"><Loading /></el-icon>
        </div>

        <div v-else>
          <el-table :data="exchanges" stripe>
            <el-table-column prop="name" label="礼品名称" />
            <el-table-column prop="description" label="描述" />
            <el-table-column label="剩余库存">
              <template #default="{ row }">
                {{ row.gift_stock ?? '-' }}
              </template>
            </el-table-column>
            <el-table-column prop="points" label="消耗积分">
              <template #default="{ row }">
                <span :class="row.status === 'cancelled' ? 'text-gray-400 line-through' : 'text-green-600'">
                  {{ row.points }}
                </span>
              </template>
            </el-table-column>
            <el-table-column prop="status" label="状态">
              <template #default="{ row }">
                <el-tag v-if="row.status === 'pending'" type="warning">待发货</el-tag>
                <el-tag v-else-if="row.status === 'shipped'" type="primary">已发货</el-tag>
                <el-tag v-else-if="row.status === 'cancelled'" type="info">已撤销</el-tag>
                <el-tag v-else type="success">已完成</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="120">
              <template #default="{ row }">
                <el-button
                  v-if="row.cancellable"
                  type="danger"
                  size="small"
                  plain
                  :loading="cancellingId === row.id"
                  @click="handleCancel(row)"
                >
                  撤销兑换
                </el-button>
                <span v-else class="text-gray-400 text-sm">不可撤销</span>
              </template>
            </el-table-column>
            <el-table-column prop="created_at" label="兑换时间">
              <template #default="{ row }">
                {{ new Date(row.created_at).toLocaleString() }}
              </template>
            </el-table-column>
          </el-table>

          <div v-if="exchanges.length === 0" class="text-center py-16 text-gray-400">
            暂无兑换记录
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { useUserStore } from '@/stores/user'
import api from '@/utils/api'
import { ElMessage, ElMessageBox } from 'element-plus'

const userStore = useUserStore()
const user = computed(() => userStore.user)

const gifts = ref([])
const exchanges = ref([])
const loading = ref(true)
const exchangesLoading = ref(true)
const activeTab = ref('gifts')
const submittingId = ref(null)
const cancellingId = ref(null)

const canExchange = (gift) => {
  if (submittingId.value === gift.id) return false
  if (!gift.is_active) return false
  if (gift.stock <= 0) return false
  return (user.value?.points || 0) >= gift.points_required
}

const exchangeButtonText = (gift) => {
  if (submittingId.value === gift.id) return '兑换中'
  if (!gift.is_active || gift.stock <= 0) return '已缺货'
  if ((user.value?.points || 0) < gift.points_required) return '积分不足'
  return '立即兑换'
}

const fetchGifts = async () => {
  loading.value = true
  try {
    const res = await api.get('/gifts')
    gifts.value = res.data.gifts
  } finally {
    loading.value = false
  }
}

const fetchExchanges = async () => {
  exchangesLoading.value = true
  try {
    const res = await api.get('/my/exchanges')
    exchanges.value = res.data.exchanges
  } finally {
    exchangesLoading.value = false
  }
}

// 每次点击生成独立幂等键：连点两次只会产生一笔兑换
const createRequestId = () => {
  if (window.crypto?.randomUUID) {
    return `ex_${window.crypto.randomUUID()}`
  }
  return `ex_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

const handleExchange = async (gift) => {
  if (submittingId.value) return
  submittingId.value = gift.id

  // 幂等键在确认前就固定，重复到达的请求会命中同一笔记录
  const requestId = createRequestId()

  try {
    await ElMessageBox.confirm(
      `确定花费 ${gift.points_required} 积分兑换「${gift.name}」吗？`,
      '确认兑换',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'info'
      }
    )

    const res = await api.post(`/gifts/${gift.id}/exchange`, { requestId })
    ElMessage.success(res.data?.duplicated ? '兑换请求已提交，请勿重复操作' : '兑换成功')
    await Promise.all([
      userStore.fetchUserInfo(),
      fetchGifts(),
      fetchExchanges()
    ])
  } catch (e) {
    if (e !== 'cancel') {
      ElMessage.error(e.response?.data?.message || '兑换失败')
    }
  } finally {
    submittingId.value = null
  }
}

const handleCancel = async (row) => {
  if (cancellingId.value) return

  try {
    await ElMessageBox.confirm(
      `撤销兑换「${row.name}」后，将退回 ${row.points} 积分并恢复 1 件库存，确定撤销吗？`,
      '确认撤销',
      {
        confirmButtonText: '确定撤销',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
  } catch (e) {
    return
  }

  cancellingId.value = row.id
  try {
    await api.post(`/exchanges/${row.id}/cancel`)
    ElMessage.success('撤销成功，积分和库存已退回')
    await Promise.all([
      userStore.fetchUserInfo(),
      fetchGifts(),
      fetchExchanges()
    ])
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '撤销失败')
  } finally {
    cancellingId.value = null
  }
}

onMounted(() => {
  fetchGifts()
  fetchExchanges()
})
</script>
