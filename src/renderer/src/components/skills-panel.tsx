import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import { Sparkles, RefreshCw, Play } from 'lucide-react'
import { useAppStore } from '../store'
import { MarkdownRenderer } from './markdown-renderer'
import type { InstalledSkill } from '../../../shared/ipc-contracts'

const SOURCE_ORDER: InstalledSkill['source'][] = ['project', 'global', 'package', 'cli']

export function SkillsPanel(): React.JSX.Element {
  const skills = useAppStore((s) => s.installedSkills)
  const loadSkills = useAppStore((s) => s.loadSkills)
  const insertPrompt = useAppStore((s) => s.insertPrompt)
  const setCurrentView = useAppStore((s) => s.setCurrentView)

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [detail, setDetail] = useState<string>('')

  useEffect(() => {
    loadSkills()
  }, [loadSkills])

  const grouped = useMemo(() => {
    const by = new Map<string, InstalledSkill[]>()
    for (const s of skills) {
      const arr = by.get(s.source) ?? []
      arr.push(s)
      by.set(s.source, arr)
    }
    return SOURCE_ORDER.filter((src) => by.has(src)).map((src) => ({
      source: src,
      items: by.get(src)!,
    }))
  }, [skills])

  const selected = skills.find((s) => s.path === selectedPath) ?? null

  useEffect(() => {
    let cancelled = false
    if (!selected) {
      setDetail('')
      return
    }
    window.piDesktop.files
      .read(selected.path)
      .then((content) => {
        if (!cancelled) setDetail(typeof content === 'string' ? content : '')
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

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="flex h-12 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-muted" />
            <h2 className="text-sm font-medium text-primary">Skills</h2>
            <span className="rounded-full bg-card px-2 py-0.5 text-xs text-dim">
              {skills.length}
            </span>
          </div>
          <button
            onClick={() => loadSkills()}
            className="rounded p-1 text-dim hover:bg-surface-hover hover:text-secondary"
            title="Refresh"
            aria-label="Refresh skills"
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {skills.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-faint">
              No skills found in ~/.pi/agent/skills or project .pi/skills
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.source} className="mb-2">
                <div className="px-4 py-1 text-[10px] uppercase tracking-wide text-faint">
                  {group.source}
                </div>
                {group.items.map((skill) => (
                  <button
                    key={skill.path}
                    onClick={() => setSelectedPath(skill.path)}
                    className={clsx(
                      'flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left transition-colors',
                      skill.path === selectedPath ? 'bg-card' : 'hover:bg-surface-hover/50'
                    )}
                  >
                    <span className="truncate text-sm text-primary">{skill.name}</span>
                    <span className="line-clamp-1 text-xs text-dim">{skill.description}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        {selected ? (
          <>
            <div className="flex h-12 items-center justify-between border-b border-border px-4">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium text-primary">{selected.name}</h3>
                <p className="truncate text-xs text-faint">{selected.path}</p>
              </div>
              <button
                onClick={() => runSkill(selected)}
                className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs text-white hover:bg-accent-hover transition-colors"
              >
                <Play size={12} />
                Run
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <MarkdownRenderer content={detail} />
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-faint">
            Select a skill to view its SKILL.md
          </div>
        )}
      </div>
    </div>
  )
}
