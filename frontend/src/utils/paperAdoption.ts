/**
 * 补纸认定领域服务
 * 规则：
 * 1. 一片书叶只留一条「采用」补纸，认定新条会盖过先前采用；
 * 2. 换选时在当前采用条上写明被换下的是哪条（id + 可读快照）；
 * 3. 叶子所在册次已装订 / 已归档（锁定）时以册次状态为准，新选一律挡回；
 * 4. 采用条被清掉后，自动回到同叶最早候选（按登记时间最早）；
 * 5. 装订登记前，书叶必须已认定采用补纸，否则不放行；
 * 6. 领用量按当前染色浓度倍率与采用条纸量重算（见 utils/paperColor）。
 *
 * 所有写操作都在 Dexie 事务内完成，保证「旧采用转候选 + 新采用落痕」原子一致。
 */
import { db } from './db'
import type { Paper } from '@/types/paper'
import { PAPER_TYPE_LABEL } from '@/types/paper'
import type { Leaf } from '@/types/leaf'
import type { Volume } from '@/types/volume'
import { isVolumeLocked } from '@/types/volume'

/** 补纸条目的可读快照，换选留痕 / 提示语使用 */
export function paperLabel(paper: Pick<Paper, 'paperType' | 'laidPattern' | 'thicknessMm' | 'deltaE'>): string {
  return `${PAPER_TYPE_LABEL[paper.paperType]}（${paper.laidPattern}·${paper.thicknessMm}mm·ΔE ${paper.deltaE}）`
}

/** 同叶候选按登记时间从早到晚排序；并列时按 id 兜底，保证「最早候选」确定 */
export function sortCandidatesByEarliest(papers: Paper[]): Paper[] {
  return [...papers].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/** 取一片叶子最早登记的候选补纸（采用条被清掉后的回落目标） */
export function earliestCandidateOfLeaf(papers: Paper[], leafId: string): Paper | undefined {
  return sortCandidatesByEarliest(papers.filter((paper) => paper.leafId === leafId))[0]
}

/** 叶子所在册次是否已装订锁定（锁定时认定 / 换选一律挡回） */
export function isLeafVolumeLocked(leaf: Leaf | undefined, volumes: Volume[]): boolean {
  const volume = volumes.find((item) => item.id === leaf?.volumeId)
  return Boolean(volume && isVolumeLocked(volume.state))
}

export class PaperAdoptionBlockedError extends Error {}

export interface AdoptPaperResult {
  /** 本次认定的采用条 */
  adopted: Paper
  /** 被换下的旧采用条（首次认定时为 null） */
  previous: Paper | null
  /** 被换下条目的可读文案，供页面提示 */
  replacedLabel: string | null
}

/**
 * 认定某条补纸为该书叶唯一采用。
 * 已认定同一条时幂等返回；叶子所在册次锁定时挡回；换选时写明被换条目。
 */
export async function adoptPaper(paperId: string): Promise<AdoptPaperResult> {
  return db.transaction('rw', [db.papers, db.leaves, db.volumes], async () => {
    const target = await db.papers.get(paperId)
    if (!target) throw new PaperAdoptionBlockedError('该补纸候选已不存在')
    const leaf = await db.leaves.get(target.leafId)
    const volume = leaf ? await db.volumes.get(leaf.volumeId) : undefined
    if (volume && isVolumeLocked(volume.state)) {
      throw new PaperAdoptionBlockedError(
        `《${volume.volumeNo}》册已装订（${volume.state === 'archived' ? '已归档' : '已装订'}），认定以册次状态为准，不能改选补纸`
      )
    }
    if (target.adopted) {
      return { adopted: target, previous: null, replacedLabel: null }
    }

    const siblings = await db.papers.where('leafId').equals(target.leafId).toArray()
    const previous = siblings.find((paper) => paper.adopted) ?? null
    const now = Date.now()

    // 旧采用转候选：清空其换选痕迹
    if (previous) {
      await db.papers.update(previous.id, {
        adopted: false,
        adoptedAt: null,
        replacedPaperId: null,
        replacedPaperLabel: null,
        updatedAt: now
      })
    }

    await db.papers.update(target.id, {
      adopted: true,
      adoptedAt: now,
      replacedPaperId: previous ? previous.id : null,
      replacedPaperLabel: previous ? paperLabel(previous) : null,
      updatedAt: now
    })

    return {
      adopted: { ...target, adopted: true, adoptedAt: now, replacedPaperId: previous?.id ?? null, replacedPaperLabel: previous ? paperLabel(previous) : null },
      previous,
      replacedLabel: previous ? paperLabel(previous) : null
    }
  })
}

/**
 * 清除某条补纸记录：
 * - 删掉的恰好是采用条时，自动把同叶最早候选认定为采用（若有剩余候选）；
 * - 册次锁定时不允许删除（整册只读）。
 */
export async function removePaperRecord(paperId: string): Promise<{ fellBackTo: Paper | null }> {
  return db.transaction('rw', [db.papers, db.leaves, db.volumes], async () => {
    const target = await db.papers.get(paperId)
    if (!target) return { fellBackTo: null }
    const leaf = await db.leaves.get(target.leafId)
    const volume = leaf ? await db.volumes.get(leaf.volumeId) : undefined
    if (volume && isVolumeLocked(volume.state)) {
      throw new PaperAdoptionBlockedError('该叶所在册次已装订，补纸记录整册只读，不能删除')
    }

    const wasAdopted = target.adopted
    await db.papers.delete(paperId)

    if (!wasAdopted) return { fellBackTo: null }

    const rest = await db.papers.where('leafId').equals(target.leafId).toArray()
    const fallback = earliestCandidateOfLeaf(rest, target.leafId)
    if (!fallback) return { fellBackTo: null }

    const now = Date.now()
    await db.papers.update(fallback.id, {
      adopted: true,
      adoptedAt: now,
      // 回到最早候选属于回落而非换选，不写「被换下条目」
      replacedPaperId: null,
      replacedPaperLabel: null,
      updatedAt: now
    })
    return { fellBackTo: { ...fallback, adopted: true, adoptedAt: now } }
  })
}

/** 取一片叶子当前认定的采用补纸 */
export function adoptedPaperOfLeaf(papers: Paper[], leafId: string): Paper | undefined {
  return papers.find((paper) => paper.leafId === leafId && paper.adopted)
}

/**
 * 装订前校验：返回一册之内尚未认定采用补纸的叶号（去重升序）。
 * 同一叶号可登记多条破损记录，只要该叶有任一记录且存在一条采用补纸即视为已认定；
 * 返回空数组表示放行。
 */
export function unadoptedLeafNos(volumeId: string, leaves: Leaf[], papers: Paper[]): number[] {
  const volumeLeaves = leaves.filter((leaf) => leaf.volumeId === volumeId)
  const leafNos = Array.from(new Set(volumeLeaves.map((leaf) => leaf.leafNo))).sort((a, b) => a - b)
  const adoptedLeafIds = new Set(papers.filter((paper) => paper.adopted).map((paper) => paper.leafId))
  const leafNoReady = new Set(
    volumeLeaves.filter((leaf) => adoptedLeafIds.has(leaf.id)).map((leaf) => leaf.leafNo)
  )
  return leafNos.filter((leafNo) => !leafNoReady.has(leafNo))
}

/** 供旧版本数据 / 旧备份导入时补齐认定字段（保持对象原样返回，缺省值按规则回填） */
export function normalizePaper(input: Partial<Paper>): Partial<Paper> {
  return {
    ...input,
    paperAmount: typeof input.paperAmount === 'number' && input.paperAmount > 0 ? input.paperAmount : 1,
    adopted: input.adopted === true,
    adoptedAt: typeof input.adoptedAt === 'number' ? input.adoptedAt : null,
    replacedPaperId: typeof input.replacedPaperId === 'string' ? input.replacedPaperId : null,
    replacedPaperLabel: typeof input.replacedPaperLabel === 'string' ? input.replacedPaperLabel : null
  }
}
