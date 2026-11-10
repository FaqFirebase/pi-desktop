import { useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { useTranslation } from 'react-i18next'
import {
  Sparkles,
  RefreshCw,
  Play,
  Search,
  Plus,
  MoreHorizontal,
  ChevronDown,
  ChevronRight,
  Pencil,
  ArrowUp,
  ArrowDown,
  Trash2,
} from 'lucide-react'
import { useAppStore } from '../store'
import { MarkdownRenderer } from './markdown-renderer'
import { useContextMenu } from './context-menu'
import { isImeComposing } from '../utils/ime-composing'
import { isRpcSkillPath } from '../../../shared/ipc-contracts'
import type { InstalledSkill } from '../../../shared/ipc-contracts'
import {
  SKILL_GROUP_NAME_MAX_LENGTH,
  addSkillGroup,
  arrangeSkills,
  assignSkillToGroup,
  moveSkillGroup,
  removeSkillGroup,
  renameSkillGroup,
  skillGroupIdOf,
  toggleSkillGroupCollapsed,
  type SkillGroup,
} from '../../../shared/skill-groups'

const SOURCE_ORDER: InstalledSkill['source'][] = ['project', 'global', 'package', 'cli']

// Same enum and English wording as status-popover.tsx's status.scope.* keys.
const SOURCE_LABEL_KEYS = {
  global: 'status.scope.global',
  project: 'status.scope.project',
  package: 'status.scope.package',
  cli: 'status.scope.cli',
} as const satisfies Record<InstalledSkill['source'], string>

// <select> values for "in no group" and "make a new group"; group ids are
// random UUIDs, so they never match these.
const NO_GROUP_VALUE = ''
const NEW_GROUP_VALUE = 'new-group'

/** A group name being typed; the skill, when set, goes into the new group. */
interface NewGroupRequest {
  skillName: string | null
}

function SkillGroupNameInput({
  initialName,
  onSubmit,
  onCancel,
}: {
  initialName: string
  onSubmit: (name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState(initialName)
  // Enter and Escape remove the input, and removing a focused input can fire
  // blur too; only the first of them may act.
  const finished = useRef(false)
  const finish = (action: () => void): void => {
    if (finished.current) return
    finished.current = true
    action()
  }
  const submit = (): void => finish(() => (name.trim() ? onSubmit(name) : onCancel()))
  return (
    <input
      type="text"
      value={name}
      maxLength={SKILL_GROUP_NAME_MAX_LENGTH}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        if (isImeComposing(e.nativeEvent)) return
        if (e.key === 'Enter') submit()
        if (e.key === 'Escape') finish(onCancel)
      }}
      onBlur={submit}
      placeholder={t('skills.groups.namePlaceholder')}
      aria-label={t('skills.groups.namePlaceholder')}
      className="mx-4 my-1 w-[calc(100%-2rem)] rounded border border-border-strong bg-card px-2 py-1 text-xs text-primary placeholder:text-faint focus:border-focus focus:outline-none"
      autoFocus
    />
  )
}

function SkillRow({
  skill,
  selected,
  onSelect,
}: {
  skill: InstalledSkill
  selected: boolean
  onSelect: (path: string) => void
}): React.JSX.Element {
  return (
    <button
      onClick={() => onSelect(skill.path)}
      className={clsx(
        'flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left transition-colors',
        selected ? 'bg-card' : 'hover:bg-surface-hover/50'
      )}
    >
      <span className="truncate text-sm text-primary">{skill.name}</span>
      <span className="line-clamp-1 text-xs text-dim">{skill.description}</span>
    </button>
  )
}

export function SkillsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const skills = useAppStore((s) => s.installedSkills)
  const loadSkills = useAppStore((s) => s.loadSkills)
  const insertPrompt = useAppStore((s) => s.insertPrompt)
  const setCurrentView = useAppStore((s) => s.setCurrentView)
  const piEngine = useAppStore((s) => s.piEngine)
  const skillGroups = useAppStore((s) => s.settings?.skillGroups)
  const updateSkillGroups = useAppStore((s) => s.updateSkillGroups)
  const requestConfirm = useAppStore((s) => s.requestConfirm)
  const { show: showContextMenu, ContextMenuComponent } = useContextMenu()

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [detail, setDetail] = useState<string>('')
  const [query, setQuery] = useState('')
  const [newGroupRequest, setNewGroupRequest] = useState<NewGroupRequest | null>(null)
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)

  useEffect(() => {
    loadSkills()
  }, [loadSkills])

  const groups = useMemo(() => skillGroups ?? [], [skillGroups])
  const arranged = useMemo(() => arrangeSkills(skills, groups, query), [skills, groups, query])
  const searching = query.trim() !== ''

  const ungroupedBySource = useMemo(() => {
    const by = new Map<string, InstalledSkill[]>()
    for (const s of arranged.ungrouped) {
      const arr = by.get(s.source) ?? []
      arr.push(s)
      by.set(s.source, arr)
    }
    return SOURCE_ORDER.filter((src) => by.has(src)).map((src) => ({
      source: src,
      items: by.get(src)!,
    }))
  }, [arranged.ungrouped])

  const selected = skills.find((s) => s.path === selectedPath) ?? null
  const selectedGroupId = selected ? skillGroupIdOf(groups, selected.name) : null

  useEffect(() => {
    let cancelled = false
    if (!selected) {
      setDetail('')
      return
    }
    if (isRpcSkillPath(selected.path)) {
      // No file on disk to read — the engine ships the skill from a plugin.
      setDetail(selected.description)
      return
    }
    window.piDesktop.skills
      .read(selected.path)
      .then((content) => {
        if (!cancelled) setDetail(content)
      })
      .catch(() => {
        if (!cancelled) setDetail('')
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  const runSkill = (skill: InstalledSkill): void => {
    insertPrompt(`/skill:${skill.name} `, true)
    setCurrentView('chat')
  }

  const createGroup = (name: string): void => {
    const skillName = newGroupRequest?.skillName ?? null
    const id = crypto.randomUUID()
    setNewGroupRequest(null)
    void updateSkillGroups((current) => {
      const added = addSkillGroup(current, id, name)
      return skillName ? assignSkillToGroup(added, skillName, id) : added
    })
  }

  const renameGroup = (id: string, name: string): void => {
    setRenamingGroupId(null)
    void updateSkillGroups((current) => renameSkillGroup(current, id, name))
  }

  const deleteGroup = async (group: SkillGroup): Promise<void> => {
    const ok = await requestConfirm({
      title: t('skills.groups.deleteConfirmTitle'),
      message: t('skills.groups.deleteConfirmMessage', { name: group.name }),
      confirmLabel: t('common.delete'),
    })
    if (ok) void updateSkillGroups((current) => removeSkillGroup(current, group.id))
  }

  const openGroupMenu = (e: React.MouseEvent, group: SkillGroup, index: number): void => {
    showContextMenu(e, [
      {
        id: 'skill-group-rename',
        label: t('skills.groups.rename'),
        icon: <Pencil size={14} />,
        action: () => setRenamingGroupId(group.id),
      },
      {
        id: 'skill-group-move-up',
        label: t('skills.groups.moveUp'),
        icon: <ArrowUp size={14} />,
        disabled: index === 0,
        action: () => void updateSkillGroups((current) => moveSkillGroup(current, group.id, -1)),
      },
      {
        id: 'skill-group-move-down',
        label: t('skills.groups.moveDown'),
        icon: <ArrowDown size={14} />,
        disabled: index === groups.length - 1,
        action: () => void updateSkillGroups((current) => moveSkillGroup(current, group.id, 1)),
      },
      { id: 'skill-group-divider', label: '', divider: true, action: () => {} },
      {
        id: 'skill-group-delete',
        label: t('skills.groups.delete'),
        icon: <Trash2 size={14} />,
        action: () => void deleteGroup(group),
      },
    ])
  }

  const hasVisibleSkills =
    arranged.ungrouped.length > 0 || arranged.groups.some((entry) => entry.skills.length > 0)

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="flex h-12 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-muted" />
            <h2 className="text-sm font-medium text-primary">{t('common.skills')}</h2>
            <span className="rounded-full bg-card px-2 py-0.5 text-xs text-dim">
              {skills.length}
            </span>
          </div>
          <button
            onClick={() => loadSkills()}
            className="rounded p-1 text-dim hover:bg-surface-hover hover:text-secondary"
            title={t('common.refresh')}
            aria-label={t('skills.refreshAriaLabel')}
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <div className="relative min-w-0 flex-1">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('skills.groups.searchPlaceholder')}
              aria-label={t('skills.groups.searchPlaceholder')}
              className="w-full rounded-md border border-border-strong bg-surface py-1.5 pl-8 pr-2 text-xs text-primary placeholder:text-faint focus:border-focus focus:outline-none"
            />
          </div>
          <button
            onClick={() => setNewGroupRequest({ skillName: null })}
            className="flex shrink-0 items-center gap-1 rounded-md border border-border-strong px-2 py-1.5 text-xs text-secondary hover:bg-surface-hover hover:text-primary"
          >
            <Plus size={12} />
            {t('skills.groups.newGroup')}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {newGroupRequest && (
            <SkillGroupNameInput
              initialName=""
              onSubmit={createGroup}
              onCancel={() => setNewGroupRequest(null)}
            />
          )}
          {groups.length === 0 && !newGroupRequest && !searching && skills.length > 0 && (
            <div className="mx-3 my-1 flex items-center justify-between gap-2 rounded-md bg-card px-3 py-2 text-xs text-dim">
              <span>{t('skills.groups.tip')}</span>
              <button
                onClick={() => setNewGroupRequest({ skillName: null })}
                className="flex shrink-0 items-center gap-1 text-accent-fg hover:underline"
              >
                <Plus size={12} />
                {t('skills.groups.newGroup')}
              </button>
            </div>
          )}
          {skills.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-faint">
              {piEngine === 'omp' ? t('skills.emptyOmp') : t('skills.emptyPi')}
            </div>
          ) : (
            <>
              {searching && !hasVisibleSkills && (
                <div className="px-4 py-8 text-center text-sm text-faint">
                  {t('skills.groups.noMatches')}
                </div>
              )}
              {arranged.groups.map(({ group, skills: groupSkills }) => {
                const index = groups.findIndex((g) => g.id === group.id)
                const expanded = searching || !group.collapsed
                return (
                  <div key={group.id} className="mb-2">
                    {renamingGroupId === group.id ? (
                      <SkillGroupNameInput
                        initialName={group.name}
                        onSubmit={(name) => renameGroup(group.id, name)}
                        onCancel={() => setRenamingGroupId(null)}
                      />
                    ) : (
                      <div
                        onContextMenu={(e) => openGroupMenu(e, group, index)}
                        className="group/header flex items-center pr-2 hover:bg-surface-hover/50"
                      >
                        <button
                          onClick={() => void updateSkillGroups((current) => toggleSkillGroupCollapsed(current, group.id))}
                          aria-expanded={expanded}
                          className="flex min-w-0 flex-1 items-center gap-1 py-1 pl-3 text-left text-xs font-medium text-secondary"
                        >
                          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          <span className="flex-1 truncate">{group.name}</span>
                          <span className="text-[10px] text-faint">{groupSkills.length}</span>
                        </button>
                        <button
                          onClick={(e) => openGroupMenu(e, group, index)}
                          title={t('skills.groups.actions')}
                          aria-label={t('skills.groups.actions')}
                          aria-haspopup="menu"
                          className="ml-1 rounded p-0.5 text-dim opacity-0 hover:bg-surface-hover hover:text-secondary focus:opacity-100 group-hover/header:opacity-100"
                        >
                          <MoreHorizontal size={13} />
                        </button>
                      </div>
                    )}
                    {expanded &&
                      (groupSkills.length === 0 ? (
                        <div className="px-4 py-1 text-xs text-faint">
                          {/* Saved names with no installed skill: the other engine's skills, or uninstalled ones. */}
                          {group.skills.length === 0 ? t('skills.groups.emptyGroup') : t('skills.groups.noneAvailable')}
                        </div>
                      ) : (
                        groupSkills.map((skill) => (
                          <SkillRow
                            key={skill.path}
                            skill={skill}
                            selected={skill.path === selectedPath}
                            onSelect={setSelectedPath}
                          />
                        ))
                      ))}
                  </div>
                )
              })}
              {ungroupedBySource.map((group) => (
                <div key={group.source} className="mb-2">
                  <div className="px-4 py-1 text-[10px] uppercase tracking-wide text-faint">
                    {t(SOURCE_LABEL_KEYS[group.source])}
                  </div>
                  {group.items.map((skill) => (
                    <SkillRow
                      key={skill.path}
                      skill={skill}
                      selected={skill.path === selectedPath}
                      onSelect={setSelectedPath}
                    />
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        {selected ? (
          <>
            {/* In a narrow pane the name and the group picker both shrink (the picker
                faster); Run never shrinks. */}
            <div className="flex h-12 items-center gap-2 border-b border-border px-4">
              <div className="min-w-0 flex-auto">
                <h3 className="truncate text-sm font-medium text-primary">{selected.name}</h3>
                <p className="truncate text-xs text-faint">
                  {isRpcSkillPath(selected.path) ? t('skills.providedByPlugin') : selected.path}
                </p>
              </div>
              <select
                value={selectedGroupId ?? NO_GROUP_VALUE}
                onChange={(e) => {
                  const value = e.target.value
                  // The select stays on the current group; the new group's name is typed in the list.
                  if (value === NEW_GROUP_VALUE) {
                    setNewGroupRequest({ skillName: selected.name })
                    return
                  }
                  const groupId = value === NO_GROUP_VALUE ? null : value
                  void updateSkillGroups((current) => assignSkillToGroup(current, selected.name, groupId))
                }}
                aria-label={t('skills.groups.groupLabel')}
                title={t('skills.groups.groupLabel')}
                className="min-w-0 max-w-40 shrink-[3] rounded-md border border-border-strong bg-surface px-2 py-1 text-xs text-secondary focus:border-focus focus:outline-none"
              >
                <option value={NO_GROUP_VALUE}>{t('skills.groups.noGroup')}</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
                <option value={NEW_GROUP_VALUE}>{t('skills.groups.newGroupOption')}</option>
              </select>
              <button
                onClick={() => runSkill(selected)}
                className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs text-white hover:bg-accent-hover transition-colors"
              >
                <Play size={12} />
                {t('skills.runButton')}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <MarkdownRenderer content={detail} />
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-faint">
            {t('skills.selectPrompt')}
          </div>
        )}
      </div>
      {ContextMenuComponent}
    </div>
  )
}
