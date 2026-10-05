<script setup lang="ts">
/**
 * /papers 补纸选配与染色比对
 * 按 ΔE 排序候选补纸并记录染色配方；ΔE 超阈值时提示重新染色。
 * 消费 Paper、Leaf；复用 <FilterBar>、<StatBadge>、<EmptyPanel>、<DamageTag>。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus } from '@element-plus/icons-vue'
import DamageTag from '@/components/common/DamageTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { useFilterQuery, type FilterModel } from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import {
  DEFAULT_DYE_RECIPE,
  DELTA_E_THRESHOLD,
  LAID_PATTERN_OPTIONS,
  PAPER_TYPE_LABEL,
  PAPER_TYPE_OPTIONS,
  createEmptyPaperDraft,
  deltaELevel,
  type Paper,
  type PaperDraft,
  type PaperType
} from '@/types/paper'
import { DAMAGE_TYPE_LABEL } from '@/types/leaf'
import {
  PaperAdoptionBlockedError,
  adoptedPaperOfLeaf,
  adoptPaper,
  isLeafVolumeLocked,
  paperLabel,
  removePaperRecord
} from '@/utils/paperAdoption'
import {
  PAPER_BASE_COLOR,
  candidateScore,
  deltaEForLeaf,
  laidPatternMatch,
  needRedye,
  recipeConcentration,
  requiredPaperAmount
} from '@/utils/paperColor'

const bookStore = useBookStore()
const leafStore = useLeafStore()
const paperTable = useIdbTable<Paper>((database) => database.papers, { sortByUpdatedAt: false })

const FILTER_KEYS = ['paperType', 'laidPattern'] as const
const url = useFilterQuery(FILTER_KEYS)
const sortBy = ref<'deltaE' | 'thickness' | 'score'>('deltaE')

const filterModel = computed<FilterModel>(() => ({
  keyword: url.keyword.value,
  paperType: url.values.value.paperType ?? [],
  laidPattern: url.values.value.laidPattern ?? []
}))

const filterSelects = [
  { key: 'paperType', label: '纸种', options: PAPER_TYPE_OPTIONS.map((item) => ({ label: item.label, value: item.value })) },
  { key: 'laidPattern', label: '帘纹', options: LAID_PATTERN_OPTIONS.map((item) => ({ label: item, value: item })) }
]

function handleFilterChange(next: FilterModel): void {
  url.apply({
    kw: typeof next.keyword === 'string' ? next.keyword : '',
    paperType: (next.paperType as string[]) ?? [],
    laidPattern: (next.laidPattern as string[]) ?? []
  })
}

function leafLabel(leafId: string): string {
  const leaf = leafStore.leafById(leafId)
  if (!leaf) return '书叶已删除'
  const volume = bookStore.volumeById(leaf.volumeId)
  const book = volume ? bookStore.bookById(volume.bookId) : undefined
  return `${book ? `《${book.title}》` : ''}第 ${volume?.volumeNo ?? '?'} 册 · 第 ${leaf.leafNo} 叶`
}

function leafPattern(leafId: string): string {
  const leaf = leafStore.leafById(leafId)
  if (!leaf) return '二指帘纹'
  return leaf.damageType === 'stain' ? '细帘纹' : '二指帘纹'
}

/** 叶子所在册次是否已装订锁定（锁定时候选只读、认定一律挡回） */
function leafLocked(leafId: string): boolean {
  return isLeafVolumeLocked(leafStore.leafById(leafId), bookStore.volumes)
}

/** 一片叶子当前认定的采用条 */
function adoptedOf(leafId: string): Paper | undefined {
  return adoptedPaperOfLeaf(paperTable.rows.value, leafId)
}

/** 按当前染色浓度与采用条纸量重算的出库领用量（张） */
function requiredAmount(paper: Paper): number {
  return requiredPaperAmount(paper.paperType, paper.deltaE, paper.paperAmount)
}

const rows = computed(() => {
  const keyword = url.keyword.value.trim()
  const types = url.values.value.paperType ?? []
  const patterns = url.values.value.laidPattern ?? []
  const list = paperTable.rows.value.filter((paper) => {
    if (keyword.length > 0) {
      const haystack = `${leafLabel(paper.leafId)}${paper.dyeRecipe}${paper.thicknessMm}`
      if (!haystack.includes(keyword)) return false
    }
    if (types.length > 0 && !types.includes(paper.paperType)) return false
    if (patterns.length > 0 && !patterns.includes(paper.laidPattern)) return false
    return true
  })
  return [...list].sort((a, b) => {
    if (sortBy.value === 'thickness') return a.thicknessMm - b.thicknessMm
    if (sortBy.value === 'score') {
      return (
        candidateScore(b, leafPattern(b.leafId)) - candidateScore(a, leafPattern(a.leafId))
      )
    }
    return a.deltaE - b.deltaE
  })
})

const stat = computed(() => {
  const list = paperTable.rows.value
  const averageDeltaE =
    list.length === 0 ? 0 : Math.round((list.reduce((sum, paper) => sum + paper.deltaE, 0) / list.length) * 100) / 100
  return {
    total: list.length,
    averageDeltaE,
    redye: list.filter((paper) => needRedye(paper.deltaE)).length,
    coveredLeaves: new Set(list.map((paper) => paper.leafId)).size,
    matchRate:
      list.length === 0
        ? 0
        : Math.round(
            (list.filter((paper) => !needRedye(paper.deltaE)).length / list.length) * 100
          )
  }
})

/* ----------------------------- 补纸表单 ----------------------------- */
const dialog = ref(false)
const editing = ref<Paper | null>(null)
const form = reactive<PaperDraft>(createEmptyPaperDraft(''))
const leafOptions = computed(() =>
  bookStore.books.flatMap((book) =>
    bookStore.volumesOfBook(book.id).flatMap((volume) =>
      leafStore.leavesOfVolume(volume.id).map((leaf) => ({
        value: leaf.id,
        label: `《${book.title}》第 ${volume.volumeNo} 册 · 第 ${leaf.leafNo} 叶 · ${DAMAGE_TYPE_LABEL[leaf.damageType]}`
      }))
    )
  )
)

function openCreate(): void {
  const firstLeaf = leafOptions.value[0]
  if (!firstLeaf) {
    ElMessage.warning('请先登记书叶')
    return
  }
  editing.value = null
  Object.assign(form, createEmptyPaperDraft(firstLeaf.value))
  dialog.value = true
}

function openEdit(paper: Paper): void {
  if (leafLocked(paper.leafId)) {
    ElMessage.warning('该书叶所在册次已装订，补纸记录整册只读')
    return
  }
  editing.value = paper
  Object.assign(form, {
    leafId: paper.leafId,
    paperType: paper.paperType,
    laidPattern: paper.laidPattern,
    thicknessMm: paper.thicknessMm,
    deltaE: paper.deltaE,
    dyeRecipe: paper.dyeRecipe,
    paperAmount: paper.paperAmount
  })
  dialog.value = true
}

// 纸种变化时带出默认染色配方
watch(
  () => form.paperType,
  (type: PaperType) => {
    const recipe = DEFAULT_DYE_RECIPE[type]
    if (!form.dyeRecipe || Object.values(DEFAULT_DYE_RECIPE).includes(form.dyeRecipe)) {
      form.dyeRecipe = recipe
    }
  }
)

const recipePreview = computed(() => recipeConcentration(form.paperType, form.deltaE, form.paperAmount))
const formMatch = computed(() => laidPatternMatch(form.laidPattern, '二指帘纹'))
const formRequiredAmount = computed(() => requiredPaperAmount(form.paperType, form.deltaE, form.paperAmount))

async function submit(): Promise<void> {
  if (!form.leafId) {
    ElMessage.warning('请选择关联书叶')
    return
  }
  if (leafLocked(form.leafId)) {
    ElMessage.warning('该书叶所在册次已装订，候选补纸整册只读')
    return
  }
  if (editing.value) {
    await paperTable.update(editing.value.id, { ...form })
    ElMessage.success('已更新补纸记录')
  } else {
    // 手工新增仅登记候选；认定唯一采用由「认定采用」动作完成
    await paperTable.create(
      {
        ...form,
        adopted: false,
        adoptedAt: null,
        replacedPaperId: null,
        replacedPaperLabel: null
      },
      'paper'
    )
    ElMessage.success(needRedye(form.deltaE) ? '已新增补纸，色差超阈值需重新染色' : '已新增补纸记录（尚未认定采用）')
  }
  dialog.value = false
}

/** 认定某条候选为该书叶唯一采用；已装订册次挡回；换选写明被换下条目 */
async function adopt(paper: Paper): Promise<void> {
  if (leafLocked(paper.leafId)) {
    ElMessage.warning('该书叶所在册次已装订，认定以册次状态为准，不能改选补纸')
    return
  }
  try {
    const result = await adoptPaper(paper.id)
    if (paper.adopted) {
      ElMessage.info('该候选已是本片书叶的采用补纸')
    } else if (result.previous && result.replacedLabel) {
      ElMessage.success(`已换选：当前采用 ${paperLabel(result.adopted)}，换下 ${result.replacedLabel}`)
    } else {
      ElMessage.success(`已认定采用 ${paperLabel(result.adopted)}`)
    }
  } catch (err) {
    if (err instanceof PaperAdoptionBlockedError) {
      ElMessage.warning(err.message)
      return
    }
    throw err
  }
}

async function adoptById(paperId: string): Promise<void> {
  const paper = paperTable.rows.value.find((item) => item.id === paperId)
  if (paper) await adopt(paper)
}

async function remove(paper: Paper): Promise<void> {
  if (leafLocked(paper.leafId)) {
    ElMessage.warning('该书叶所在册次已装订，补纸记录整册只读，不能删除')
    return
  }
  try {
    await ElMessageBox.confirm(
      paper.adopted ? '该条是当前采用补纸，删除后将自动回到本片书叶最早登记的候选。' : '将删除该补纸选配记录。',
      '删除补纸',
      {
        type: 'warning',
        confirmButtonText: '确认删除',
        cancelButtonText: '取消'
      }
    )
  } catch {
    return
  }
  const { fellBackTo } = await removePaperRecord(paper.id)
  if (fellBackTo) {
    ElMessage.success(`已删除，并自动回到最早候选：${paperLabel(fellBackTo)}`)
  } else if (paper.adopted) {
    ElMessage.success('已删除采用条，本片书叶已无候选，请重新配纸')
  } else {
    ElMessage.success('已删除')
  }
}

/* ----------------------------- 候选推荐 ----------------------------- */
const candidateLeafId = ref('')
const candidateLocked = computed(() => (candidateLeafId.value ? leafLocked(candidateLeafId.value) : false))
const candidateAdopted = computed(() => (candidateLeafId.value ? adoptedOf(candidateLeafId.value) : undefined))
const candidates = computed(() => {
  if (!candidateLeafId.value) return []
  const leaf = leafStore.leafById(candidateLeafId.value)
  if (!leaf) return []
  const patterns = ['二指帘纹', '三指帘纹', '细帘纹']
  return PAPER_TYPE_OPTIONS.map((option) => {
    const paper = paperTable.rows.value.find(
      (item) => item.leafId === leaf.id && item.paperType === option.value
    )
    const deltaE = paper ? paper.deltaE : deltaEForLeaf(leaf.damageType, option.value)
    const laidPattern = paper ? paper.laidPattern : patterns[leaf.leafNo % patterns.length]
    const thicknessMm = paper ? paper.thicknessMm : 0.06
    return {
      type: option.value,
      label: PAPER_TYPE_LABEL[option.value],
      deltaE,
      laidPattern,
      thicknessMm,
      score: candidateScore({ deltaE, laidPattern, thicknessMm }, '二指帘纹'),
      hasRecord: Boolean(paper),
      paperId: paper?.id ?? '',
      adopted: paper?.adopted ?? false,
      replacedPaperLabel: paper?.replacedPaperLabel ?? null
    }
  }).sort((a, b) => b.score - a.score)
})

const candidateLeafPattern = computed(() =>
  candidateLeafId.value ? leafPattern(candidateLeafId.value) : '二指帘纹'
)

/** 候选推荐卡片只负责登记 / 更新候选记录；认定唯一采用由 adopt() 完成 */
async function selectCandidate(type: PaperType, deltaE: number, laidPatternValue: string, thicknessMm: number): Promise<void> {
  if (!candidateLeafId.value) return
  if (candidateLocked.value) {
    ElMessage.warning('该书叶所在册次已装订，候选补纸整册只读')
    return
  }
  const existing = paperTable.rows.value.find(
    (item) => item.leafId === candidateLeafId.value && item.paperType === type
  )
  const payload: PaperDraft = {
    leafId: candidateLeafId.value,
    paperType: type,
    laidPattern: laidPatternValue,
    thicknessMm,
    deltaE,
    dyeRecipe: DEFAULT_DYE_RECIPE[type],
    paperAmount: existing?.paperAmount ?? 1
  }
  if (existing) {
    await paperTable.update(existing.id, payload)
    ElMessage.success(`已更新${PAPER_TYPE_LABEL[type]}候选`)
  } else {
    await paperTable.create(
      { ...payload, adopted: false, adoptedAt: null, replacedPaperId: null, replacedPaperLabel: null },
      'paper'
    )
    ElMessage.success(`已登记${PAPER_TYPE_LABEL[type]}候选，请在列表中「认定采用」`)
  }
}

function deltaTag(deltaE: number): { label: string; color: string } {
  return deltaELevel(deltaE)
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>补纸选配与染色比对</h2>
        <p>
          按 ΔE 升序排列候选补纸（阈值 {{ DELTA_E_THRESHOLD }}），记录帘纹、厚度与染色配方；超阈值会提示重新染色。
        </p>
      </div>
      <div class="gb-toolbar">
        <el-select v-model="sortBy" style="width: 160px">
          <el-option label="按 ΔE 升序" value="deltaE" />
          <el-option label="按厚度升序" value="thickness" />
          <el-option label="按综合评分" value="score" />
        </el-select>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增补纸</el-button>
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="补纸记录" :value="stat.total" suffix="条" tone="primary" />
      <StatBadge label="平均 ΔE" :value="stat.averageDeltaE" tone="warning" />
      <StatBadge label="需重新染色" :value="stat.redye" suffix="条" tone="danger" />
      <StatBadge label="覆盖书叶" :value="stat.coveredLeaves" suffix="叶" tone="info" />
      <StatBadge label="ΔE 达标率" :value="`${stat.matchRate}%`" :percent="stat.matchRate" tone="success" />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索书叶 / 配方 / 厚度…"
      @change="handleFilterChange"
      @reset="url.reset()"
    />

    <el-row :gutter="16" style="margin-top: 16px">
      <el-col :xs="24" :xl="16">
        <el-card shadow="never">
          <EmptyPanel
            v-if="rows.length === 0"
            :title="paperTable.rows.value.length === 0 ? '还没有补纸选配记录' : '当前条件下没有记录'"
            :description="
              paperTable.rows.value.length === 0
                ? '为破损书叶选配补纸，记录纸种、帘纹、厚度、色差与染色配方。'
                : '试着调整纸种或帘纹筛选条件。'
            "
            action-text="新增补纸"
            secondary-text="重置筛选"
            size="small"
            @action="openCreate"
            @secondary="url.reset()"
          />
          <el-table v-else :data="rows" size="small" border>
            <el-table-column label="关联书叶" min-width="200">
              <template #default="{ row }">
                <div>{{ leafLabel(row.leafId) }}</div>
                <div class="gb-muted">
                  <DamageTag v-if="leafStore.leafById(row.leafId)" :type="leafStore.leafById(row.leafId)!.damageType" size="small" />
                </div>
              </template>
            </el-table-column>
            <el-table-column label="纸种" width="90">
              <template #default="{ row }">{{ PAPER_TYPE_LABEL[row.paperType as PaperType] }}</template>
            </el-table-column>
            <el-table-column label="帘纹" width="150">
              <template #default="{ row }">
                {{ row.laidPattern }}
                <el-tag size="small" effect="plain" round>{{ laidPatternMatch(row.laidPattern, leafPattern(row.leafId)) }}%</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="thicknessMm" label="厚度(mm)" width="100" />
            <el-table-column label="ΔE" width="140" sortable>
              <template #default="{ row }">
                {{ row.deltaE }}
                <el-tag :style="{ color: deltaTag(row.deltaE).color, borderColor: `${deltaTag(row.deltaE).color}66` }" effect="plain" size="small" round>
                  {{ deltaTag(row.deltaE).label }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="综合评分" width="100">
              <template #default="{ row }">{{ candidateScore(row, leafPattern(row.leafId)) }}</template>
            </el-table-column>
            <el-table-column label="认定 / 领用" width="210">
              <template #default="{ row }">
                <el-tag v-if="row.adopted" type="success" effect="dark" size="small" round>采用中</el-tag>
                <el-tag v-else type="info" effect="plain" size="small" round>候选</el-tag>
                <div class="gb-muted">纸量 {{ row.paperAmount }} 张 · 领用量 {{ requiredAmount(row) }} 张</div>
                <div v-if="row.replacedPaperLabel" class="gb-muted" style="color: #d68910">
                  换下：{{ row.replacedPaperLabel }}
                </div>
              </template>
            </el-table-column>
            <el-table-column label="染色配方" min-width="200">
              <template #default="{ row }">
                <el-tag v-if="needRedye(row.deltaE)" type="danger" effect="plain" size="small" round>需重新染色</el-tag>
                <div class="gb-muted">{{ row.dyeRecipe }}</div>
                <div class="gb-muted">
                  当前 {{ recipeConcentration(row.paperType, row.deltaE, row.paperAmount).multiplier }} 倍浓度
                </div>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="220">
              <template #default="{ row }">
                <el-button
                  size="small"
                  :type="row.adopted ? 'success' : 'primary'"
                  :disabled="row.adopted || leafLocked(row.leafId)"
                  @click="adopt(row)"
                >
                  {{ row.adopted ? '已采用' : '认定采用' }}
                </el-button>
                <el-button size="small" text :icon="Edit" :disabled="leafLocked(row.leafId)" @click="openEdit(row)">编辑</el-button>
                <el-button size="small" text type="danger" :icon="Delete" :disabled="leafLocked(row.leafId)" @click="remove(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :xs="24" :xl="8">
        <el-card shadow="never">
          <template #header>候选补纸推荐</template>
          <el-select v-model="candidateLeafId" placeholder="选择需要配纸的书叶" style="width: 100%; margin-bottom: 10px">
            <el-option v-for="item in leafOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>

          <el-alert
            v-if="candidateLocked"
            type="warning"
            show-icon
            :closable="false"
            style="margin-bottom: 10px"
            title="该片书叶所在册次已装订"
            description="认定以册次状态为准，候选补纸整册只读，不能新选或改选。"
          />
          <el-alert
            v-else-if="candidateAdopted"
            type="success"
            show-icon
            :closable="false"
            style="margin-bottom: 10px"
            :title="`已认定采用：${paperLabel(candidateAdopted)}`"
            :description="candidateAdopted.replacedPaperLabel ? `此前换下：${candidateAdopted.replacedPaperLabel}` : '一片叶子只留一条采用；改选其他候选会盖过当前采用并留痕。'"
          />
          <el-alert
            v-else-if="candidateLeafId"
            type="info"
            show-icon
            :closable="false"
            style="margin-bottom: 10px"
            title="该片书叶尚未认定采用补纸"
            description="请登记候选后点击「认定采用」；未认定的书叶装订登记将不放行。"
          />

          <EmptyPanel
            v-if="candidates.length === 0"
            title="选择书叶后生成候选"
            description="将按 ΔE、帘纹匹配度与厚度接近度综合评分排序。"
            size="small"
          />
          <div v-else style="display: flex; flex-direction: column; gap: 10px">
            <div v-for="item in candidates" :key="item.type">
              <div class="gb-paper-swatch" :style="{ background: PAPER_BASE_COLOR[item.type] }" />
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px">
                <div>
                  <strong>{{ item.label }}</strong>
                  <span class="gb-muted"> · 评分 {{ item.score }}</span>
                  <el-tag v-if="item.adopted" type="success" effect="dark" size="small" round style="margin-left: 6px">采用中</el-tag>
                </div>
                <el-tag :type="needRedye(item.deltaE) ? 'danger' : 'success'" effect="plain" size="small" round>
                  ΔE {{ item.deltaE }}
                </el-tag>
              </div>
              <div class="gb-muted">
                帘纹 {{ item.laidPattern }}（匹配 {{ laidPatternMatch(item.laidPattern, candidateLeafPattern) }}%）· 厚度
                {{ item.thicknessMm }}mm · {{ item.hasRecord ? '已有登记' : '尚无登记（按基准色估算）' }}
              </div>
              <div v-if="item.adopted && item.replacedPaperLabel" class="gb-muted" style="color: #d68910">
                换下：{{ item.replacedPaperLabel }}
              </div>
              <div style="display: flex; gap: 8px; margin-top: 6px">
                <el-button
                  size="small"
                  :type="item.adopted ? 'success' : 'primary'"
                  :disabled="item.adopted || candidateLocked || !item.hasRecord"
                  @click="item.hasRecord && adoptById(item.paperId)"
                >
                  {{ item.adopted ? '已采用' : '认定采用' }}
                </el-button>
                <el-button size="small" :disabled="candidateLocked" @click="selectCandidate(item.type, item.deltaE, item.laidPattern, item.thicknessMm)">
                  {{ item.hasRecord ? '更新候选' : '登记候选' }}
                </el-button>
              </div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="dialog" :title="editing ? '编辑补纸记录' : '新增补纸记录'" width="620px">
      <el-form label-width="110px">
        <el-form-item label="关联书叶" required>
          <el-select v-model="form.leafId" style="width: 100%" filterable>
            <el-option v-for="item in leafOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="纸种" required>
          <el-select v-model="form.paperType" style="width: 100%">
            <el-option v-for="item in PAPER_TYPE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="帘纹">
          <el-select v-model="form.laidPattern" style="width: 100%">
            <el-option v-for="item in LAID_PATTERN_OPTIONS" :key="item" :label="item" :value="item" />
          </el-select>
          <span class="gb-muted">与目标帘纹匹配度 {{ formMatch }}%</span>
        </el-form-item>
        <el-form-item label="厚度(mm)">
          <el-input-number v-model="form.thicknessMm" :min="0.01" :max="0.5" :step="0.01" :precision="2" />
        </el-form-item>
        <el-form-item label="纸量(张)">
          <el-input-number v-model="form.paperAmount" :min="0.5" :max="50" :step="0.5" :precision="1" />
          <span class="gb-muted" style="margin-left: 8px">
            按当前染色浓度 {{ recipePreview.multiplier }} 倍，领用量 {{ formRequiredAmount }} 张
          </span>
        </el-form-item>
        <el-form-item label="色差 ΔE">
          <el-input-number v-model="form.deltaE" :min="0" :max="20" :step="0.1" :precision="1" />
          <el-tag
            style="margin-left: 8px"
            :style="{ color: deltaTag(form.deltaE).color, borderColor: `${deltaTag(form.deltaE).color}66` }"
            effect="plain"
            round
          >
            {{ deltaTag(form.deltaE).label }}
          </el-tag>
        </el-form-item>
        <el-form-item label="染色配方">
          <el-input v-model="form.dyeRecipe" type="textarea" :rows="2" />
          <span class="gb-muted">{{ recipePreview.note }}</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
