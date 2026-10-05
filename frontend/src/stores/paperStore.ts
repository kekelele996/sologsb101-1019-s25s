/**
 * 补纸 store（Pinia setup store）
 * 维护补纸清单与「认定采用」逻辑：
 * - 一片书叶只留一条采用，新选盖过先前，并在被换补纸上写明 replacedBy（被哪条替换）；
 * - 册次已装订完成（已装订 / 已归档）时以册次状态为准，新选挡回；
 * - 采用的补纸被清掉后回到最早候选。
 * 领用量按当前染色浓度与采用那条补纸的纸量（叶破损面积 cm²）重算。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db } from '@/utils/db'
import { dyeRequisition } from '@/utils/paperColor'
import { isVolumeLocked } from '@/types/volume'
import type { Paper, PaperDraft } from '@/types/paper'
import { useLeafStore } from './leafStore'
import { useBookStore } from './bookStore'

export const usePaperStore = defineStore('paper', () => {
  const papers = ref<Paper[]>([])
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  async function loadPapers(): Promise<void> {
    loading.value = true
    try {
      const rows = await db.papers.toArray()
      rows.sort((a, b) => (a.leafId === b.leafId ? a.createdAt - b.createdAt : a.leafId.localeCompare(b.leafId)))
      papers.value = rows
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '补纸读取失败'
    } finally {
      loading.value = false
    }
  }

  /** 某叶的全部补纸候选，按登记先后（createdAt）升序 */
  function papersOfLeaf(leafId: string): Paper[] {
    return papers.value
      .filter((paper) => paper.leafId === leafId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  /** 某叶当前认定采用的补纸（一片叶至多一条） */
  function adoptedPaperOfLeaf(leafId: string): Paper | undefined {
    return papers.value.find((paper) => paper.leafId === leafId && paper.adopted)
  }

  /** 已有采用补纸的书叶 id 集合 */
  const adoptedLeafIds = computed<Set<string>>(
    () => new Set(papers.value.filter((paper) => paper.adopted).map((paper) => paper.leafId))
  )

  function isLeafAdopted(leafId: string): boolean {
    return adoptedLeafIds.value.has(leafId)
  }

  /**
   * 新选采用是否被册次状态挡回。
   * 叶子所在册次已装订完成（已装订 / 已归档）时以册次状态为准，新选的先挡回。
   */
  function adoptionBlocked(leafId: string): { blocked: boolean; reason: string } {
    const leafStore = useLeafStore()
    const bookStore = useBookStore()
    const leaf = leafStore.leafById(leafId)
    if (!leaf) return { blocked: true, reason: '书叶不存在' }
    const volume = bookStore.volumeById(leaf.volumeId)
    if (volume && isVolumeLocked(volume.state)) {
      return { blocked: true, reason: '册次已装订完成，以册次状态为准，新选补纸挡回' }
    }
    return { blocked: false, reason: '' }
  }

  /**
   * 认定采用：一片叶只留一条采用。
   * 新选盖过先前采用，并在被换补纸上写明 replacedBy（被哪条替换）。
   * 册次已装订完成时抛错挡回。
   */
  async function adoptPaper(leafId: string, paperId: string): Promise<void> {
    const check = adoptionBlocked(leafId)
    if (check.blocked) throw new Error(check.reason)
    const target = papers.value.find((paper) => paper.id === paperId && paper.leafId === leafId)
    if (!target) throw new Error('补纸不存在，无法认定采用')
    const now = Date.now()
    await db.transaction('rw', db.papers, async () => {
      const rows = await db.papers.where('leafId').equals(leafId).toArray()
      const current = rows.find((paper) => paper.adopted && paper.id !== paperId)
      if (current) {
        await db.papers.update(current.id, { adopted: false, replacedBy: paperId, updatedAt: now })
      }
      await db.papers.update(paperId, { adopted: true, replacedBy: null, adoptedAt: now, updatedAt: now })
    })
    await loadPapers()
  }

  /** 新增补纸（默认不认定采用） */
  async function createPaper(draft: PaperDraft): Promise<Paper> {
    const now = Date.now()
    const row: Paper = { ...draft, id: createId('paper'), createdAt: now, updatedAt: now }
    await db.papers.put(row)
    await loadPapers()
    return row
  }

  async function updatePaper(id: string, patch: Partial<Paper>): Promise<void> {
    await db.papers.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadPapers()
  }

  /**
   * 删除补纸。若删的是当前采用补纸，则回到最早候选（登记最早的一条）。
   */
  async function removePaper(paperId: string): Promise<void> {
    const target = papers.value.find((paper) => paper.id === paperId)
    if (!target) return
    const now = Date.now()
    await db.transaction('rw', db.papers, async () => {
      await db.papers.delete(paperId)
      if (target.adopted) {
        const remaining = await db.papers.where('leafId').equals(target.leafId).toArray()
        remaining.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        const earliest = remaining[0]
        if (earliest) {
          await db.papers.update(earliest.id, { adopted: true, replacedBy: null, adoptedAt: now, updatedAt: now })
        }
      }
    })
    await loadPapers()
  }

  /** 装订放行检查：返回某册下尚未认定采用补纸的书叶（按叶号升序） */
  function leavesMissingAdoption(volumeId: string) {
    const leafStore = useLeafStore()
    return leafStore
      .leavesOfVolume(volumeId)
      .filter((leaf) => !adoptedLeafIds.value.has(leaf.id))
      .sort((a, b) => a.leafNo - b.leafNo)
  }

  /**
   * 领用量：按当前染色浓度（ΔE 对应倍率）与采用那条补纸的纸量（叶破损面积 cm²）重算。
   * 无采用补纸时返回 null。
   */
  function requisitionOfAdopted(leafId: string) {
    const leafStore = useLeafStore()
    const adopted = adoptedPaperOfLeaf(leafId)
    const leaf = leafStore.leafById(leafId)
    if (!adopted || !leaf) return null
    const result = dyeRequisition(adopted.paperType, adopted.deltaE, leaf.damageAreaCm2)
    return { ...result, paperType: adopted.paperType, deltaE: adopted.deltaE }
  }

  return {
    papers,
    loading,
    ready,
    error,
    loadPapers,
    papersOfLeaf,
    adoptedPaperOfLeaf,
    adoptedLeafIds,
    isLeafAdopted,
    adoptionBlocked,
    adoptPaper,
    createPaper,
    updatePaper,
    removePaper,
    leavesMissingAdoption,
    requisitionOfAdopted
  }
})

export default usePaperStore
