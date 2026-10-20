/**
 * dsh-checklist — client half (right-sidebar tab).
 *
 * Loaded by the DSH web module loader, not by Node. The loader calls
 * `factory(require)` and the factory returns the module exports; only `react`
 * is reachable through `require`, and every service arrives on the `ctx` that
 * `apply` receives.
 *
 * The tab is read-mostly: it polls the host state route and renders. The one
 * thing it can change is an item's TEXT, through a narrow POST that refuses to
 * overwrite a value it did not read (409 on conflict). States stay agent-only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-checklists',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const TAB_ID = 'dsh-checklists'
    const TAB_KIND = 'checklist'
    const STATE_ROUTE = '/dsh-checklist/state'
    const ITEM_ROUTE = '/dsh-checklist/item'
    const PROBE_ROUTE = '/dsh-checklist/client-probe'
    const POLL_MS = 2000
    const MAX_TEXT = 500

    const GLYPH = { done: '✓', doing: '◐', blocked: '!', todo: '○' }
    const COLOR = { done: '#3fb950', doing: '#d29922', blocked: '#f85149', todo: 'inherit' }

    const MUTED = { opacity: 0.72, fontSize: 13, padding: '10px 12px', lineHeight: 1.5 }
    const BUTTON = {
      background: 'transparent',
      border: 'none',
      color: 'inherit',
      opacity: 0.62,
      cursor: 'pointer',
      fontSize: 11,
      fontFamily: 'inherit',
      padding: '2px 5px',
      borderRadius: 4,
    }

    /**
     * User-facing strings. Model-facing text (tool descriptions, the digest)
     * deliberately stays out of here: it is prompt material, not UI copy.
     *
     * English is the fallback for every other locale — the harness can report
     * any BCP-47 tag, and a half-translated panel is worse than an English one.
     */
    const STRINGS = {
      en: {
        title: 'Checklist',
        loading: 'Loading checklist…',
        noSession: 'No active session.',
        readError: 'Could not read the checklist',
        retrying: 'Retrying…',
        emptyTitle: 'No checklist in this session',
        emptyHint: 'Ask the agent to create one: “make me a checklist for…”.',
        hideDone: 'Hide done',
        showDone: 'Show done',
        hideDoneHint: 'Hide or show completed items',
        copy: 'Copy',
        copyHint: 'Copy the checklist as markdown',
        copied: '✓ Copied',
        copyFailed: 'Could not copy',
        noClipboard: 'Clipboard unavailable',
        allDone: 'All done.',
        editHint: 'Double-click to edit the text',
        collapse: 'Collapse',
        expand: 'Expand',
        tooLong: 'Text is too long',
        conflict: 'The item changed while you were editing; try again',
        missing: 'The item no longer exists',
        saveFailed: 'Could not save',
      },
      es: {
        title: 'Checklist',
        loading: 'Cargando checklist…',
        noSession: 'Sin sesión activa.',
        readError: 'No se pudo leer el checklist',
        retrying: 'Reintentando…',
        emptyTitle: 'Sin checklist en esta sesión',
        emptyHint: 'Pídele al agente que cree uno: «hazme un checklist para…».',
        hideDone: 'Ocultar hechos',
        showDone: 'Mostrar hechos',
        hideDoneHint: 'Ocultar o mostrar los ítems hechos',
        copy: 'Copiar',
        copyHint: 'Copiar el checklist como markdown',
        copied: '✓ Copiado',
        copyFailed: 'No se pudo copiar',
        noClipboard: 'Portapapeles no disponible',
        allDone: 'Todo hecho.',
        editHint: 'Doble clic para editar el texto',
        collapse: 'Colapsar',
        expand: 'Expandir',
        tooLong: 'Texto demasiado largo',
        conflict: 'El ítem cambió mientras editabas; reintenta',
        missing: 'El ítem ya no existe',
        saveFailed: 'No se pudo guardar',
      },
    }

    function readLang(locale) {
      try {
        const active = locale && typeof locale.getSnapshot === 'function' ? locale.getSnapshot().active : ''
        return String(active || '').toLowerCase().startsWith('es') ? 'es' : 'en'
      } catch (_) {
        return 'en'
      }
    }

    function makeT(lang) {
      const table = STRINGS[lang] || STRINGS.en
      return (key) => (table[key] !== undefined ? table[key] : STRINGS.en[key] !== undefined ? STRINGS.en[key] : key)
    }

    /** Follow the locale service, including later changes. */
    function useLang(locale) {
      const [lang, setLang] = React.useState(() => readLang(locale))

      React.useEffect(() => {
        if (!locale || typeof locale.subscribe !== 'function') return undefined
        const update = () => setLang(readLang(locale))
        update()
        const unsubscribe = locale.subscribe(update)
        return typeof unsubscribe === 'function' ? unsubscribe : undefined
      }, [locale])

      return lang
    }

    /**
     * Report one load/registration stage to the host.
     *
     * The browser console is not reachable from the host, so the plugin tells
     * the host where it got to. This is how "the tab is missing" is told apart
     * from "the module never loaded". Never throws.
     *
     * @param stage - short stage label.
     * @param detail - optional extra context, truncated by the host.
     */
    function report(stage, detail) {
      try {
        const url = `${PROBE_ROUTE}?stage=${encodeURIComponent(stage)}&detail=${encodeURIComponent(String(detail || '').slice(0, 400))}`
        fetch(url, { cache: 'no-store' }).catch(() => {})
      } catch (_) {
        // Diagnostics must never break the plugin.
      }
    }

    function useChecklistState(sessionId) {
      const [snapshot, setSnapshot] = React.useState({ phase: 'loading' })

      React.useEffect(() => {
        if (!sessionId) {
          setSnapshot({ phase: 'no-session' })
          return undefined
        }

        let alive = true
        let timer = null

        const load = async () => {
          try {
            const response = await fetch(`${STATE_ROUTE}?session=${encodeURIComponent(sessionId)}`, {
              cache: 'no-store',
              headers: { accept: 'application/json' },
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            if (alive) setSnapshot({ phase: 'ready', data })
          } catch (error) {
            if (alive) setSnapshot({ phase: 'error', message: String((error && error.message) || error) })
          }
        }

        void load()
        timer = setInterval(() => void load(), POLL_MS)
        return () => {
          alive = false
          if (timer) clearInterval(timer)
        }
      }, [sessionId])

      return snapshot
    }

    /**
     * Save one item's new text.
     *
     * `expectedText` makes the write optimistic-checked: the host answers 409
     * when the item changed since this tab read it, instead of silently
     * clobbering the agent's edit.
     *
     * Returns a machine-readable code, not a sentence: the caller owns the
     * locale, this function does not.
     *
     * @param sessionId - current session.
     * @param itemId - item to change.
     * @param text - new text.
     * @param expectedText - the text this tab last saw.
     * @returns `{ ok }` or `{ ok: false, code, status? }`.
     */
    async function saveItem(sessionId, itemId, text, expectedText) {
      try {
        const response = await fetch(ITEM_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session: sessionId, itemId, text, expectedText }),
        })
        if (response.ok) return { ok: true }
        if (response.status === 409) return { ok: false, code: 'conflict' }
        if (response.status === 404) return { ok: false, code: 'missing' }
        return { ok: false, code: 'http', status: response.status }
      } catch {
        return { ok: false, code: 'network' }
      }
    }

    function countTree(items) {
      let total = 0
      let done = 0
      for (const item of items || []) {
        total += 1
        if (item.state === 'done') done += 1
        const nested = countTree(item.children)
        total += nested.total
        done += nested.done
      }
      return { total, done }
    }

    function withoutDone(items) {
      const out = []
      for (const item of items || []) {
        const children = withoutDone(item.children)
        const wasOpen = (item.children || []).length !== children.length
        if (item.state === 'done' && children.length === 0) continue
        out.push(wasOpen ? { ...item, children } : item)
      }
      return out
    }

    function toMarkdown(data) {
      const lines = [`## Checklist · ${data.counts.done}/${data.counts.total}`, '']
      for (const list of data.lists || []) {
        lines.push(`### ${list.title}`)
        const walk = (items, depth) => {
          for (const item of items || []) {
            const mark = item.state === 'done' ? 'x' : ' '
            lines.push(`${'  '.repeat(depth)}- [${mark}] ${item.text}`)
            walk(item.children, depth + 1)
          }
        }
        walk(list.items, 0)
        lines.push('')
      }
      return lines.join('\n')
    }

    function Progress(props) {
      const total = props.total || 0
      const done = props.done || 0
      const pct = total > 0 ? Math.round((done / total) * 100) : 0
      return h(
        'div',
        {
          style: {
            height: 4,
            borderRadius: 2,
            background: 'rgba(127,127,127,0.25)',
            margin: '0 0 12px',
            overflow: 'hidden',
          },
        },
        h('div', {
          style: {
            height: '100%',
            width: `${pct}%`,
            background: '#3fb950',
            transition: 'width 200ms ease',
          },
        }),
      )
    }

    function Item(props) {
      const item = props.item
      const depth = props.depth || 0
      const done = item.state === 'done'
      const children = item.children || []
      const isEditing = props.editing && props.editing.id === item.id
      const nodeKey = `${props.listId}/${item.id}`
      const isCollapsed = Boolean(props.collapsed[nodeKey])
      const counts = countTree(children)

      const label = isEditing
        ? h('input', {
            value: props.editing.draft,
            autoFocus: true,
            maxLength: MAX_TEXT,
            onChange: (event) => props.onDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                props.onCommit()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                props.onCancel()
              }
            },
            onBlur: () => props.onCommit(),
            style: {
              flex: 1,
              minWidth: 0,
              font: 'inherit',
              color: 'inherit',
              background: 'rgba(127,127,127,0.15)',
              border: '1px solid rgba(127,127,127,0.45)',
              borderRadius: 4,
              padding: '1px 4px',
            },
          })
        : h(
            'span',
            {
              onDoubleClick: () => props.onStartEdit(item),
              title: props.t('editHint'),
              style: {
                textDecoration: done ? 'line-through' : 'none',
                wordBreak: 'break-word',
                cursor: 'text',
              },
            },
            item.text,
          )

      const chevron =
        children.length > 0
          ? h(
              'button',
              {
                onClick: (event) => {
                  event.preventDefault()
                  props.onToggleNode(nodeKey)
                },
                title: isCollapsed ? props.t('expand') : props.t('collapse'),
                style: {
                  ...BUTTON,
                  flex: '0 0 12px',
                  width: 12,
                  padding: 0,
                  fontSize: 9,
                  textAlign: 'center',
                },
              },
              isCollapsed ? '▸' : '▾',
            )
          : h('span', { style: { flex: '0 0 12px', width: 12 } })

      return h(
        'li',
        { style: { listStyle: 'none', margin: 0, padding: 0 } },
        h(
          'div',
          {
            style: {
              display: 'flex',
              gap: 6,
              alignItems: 'baseline',
              paddingLeft: depth * 14,
              paddingBlock: 1,
              opacity: done ? 0.55 : 1,
            },
          },
          h(
            'span',
            {
              style: {
                color: COLOR[item.state] || 'inherit',
                flex: '0 0 14px',
                width: 14,
                textAlign: 'center',
                fontSize: 12,
              },
            },
            GLYPH[item.state] || '·',
          ),
          chevron,
          label,
          isCollapsed && children.length > 0
            ? h(
                'span',
                { style: { opacity: 0.5, fontSize: 11, flex: '0 0 auto' } },
                `${counts.done}/${counts.total}`,
              )
            : null,
        ),
        !isCollapsed && children.length > 0
          ? h(
              'ul',
              { style: { margin: 0, padding: 0 } },
              children.map((child) =>
                h(Item, {
                  key: child.id,
                  item: child,
                  depth: depth + 1,
                  t: props.t,
                  listId: props.listId,
                  collapsed: props.collapsed,
                  onToggleNode: props.onToggleNode,
                  editing: props.editing,
                  onStartEdit: props.onStartEdit,
                  onDraft: props.onDraft,
                  onCommit: props.onCommit,
                  onCancel: props.onCancel,
                }),
              ),
            )
          : null,
      )
    }

    function List(props) {
      const list = props.list
      const collapsed = Boolean(props.collapsed[list.id])
      const source = props.hideDone ? withoutDone(list.items) : list.items || []
      const counts = countTree(list.items)

      const header = h(
        'button',
        {
          onClick: () => props.onToggleNode(list.id),
          title: collapsed ? props.t('expand') : props.t('collapse'),
          style: {
            ...BUTTON,
            opacity: 0.9,
            fontWeight: 600,
            fontSize: 12.5,
            display: 'flex',
            alignItems: 'baseline',
            gap: 5,
            width: '100%',
            textAlign: 'left',
            padding: '2px 0',
            marginBottom: 3,
          },
        },
        h('span', { style: { opacity: 0.55, fontSize: 10 } }, collapsed ? '▸' : '▾'),
        h('span', null, list.title),
        h('span', { style: { opacity: 0.55, fontWeight: 400 } }, `${counts.done}/${counts.total}`),
      )

      let body = null
      if (!collapsed) {
        body = source.length === 0
          ? h('div', { style: { opacity: 0.55, fontSize: 12, paddingLeft: 4 } }, props.t('allDone'))
          : h(
              'ul',
              { style: { margin: 0, padding: 0 } },
              source.map((item) =>
                h(Item, {
                  key: item.id,
                  item,
                  depth: 0,
                  t: props.t,
                  listId: list.id,
                  collapsed: props.collapsed,
                  onToggleNode: props.onToggleNode,
                  editing: props.editing,
                  onStartEdit: props.onStartEdit,
                  onDraft: props.onDraft,
                  onCommit: props.onCommit,
                  onCancel: props.onCancel,
                }),
              ),
            )
      }

      return h('section', { style: { marginBottom: 12 } }, header, body)
    }

    function ChecklistBody(props) {
      const sessionId = props && props.sessionId
      const snapshot = useChecklistState(sessionId)
      const lang = useLang(props && props.locale)
      const t = makeT(lang)

      const [hideDone, setHideDone] = React.useState(false)
      const [collapsed, setCollapsed] = React.useState({})
      const [editing, setEditing] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [copied, setCopied] = React.useState(false)
      const editingRef = React.useRef(null)
      const knownLists = React.useRef(null)

      React.useEffect(() => {
        editingRef.current = editing
      }, [editing])

      // A brand-new checklist takes the stage: collapse every other list so it
      // is the one you see. Only a genuinely new id triggers it — reacting to
      // every poll would fight the user's own expand/collapse every 2 seconds.
      React.useEffect(() => {
        if (!sessionId || snapshot.phase !== 'ready') return
        const lists = (snapshot.data && snapshot.data.lists) || []
        const ids = lists.map((list) => list.id)
        const previous = knownLists.current
        knownLists.current = new Set(ids)
        if (!previous) return

        const fresh = new Set(ids.filter((id) => !previous.has(id)))
        if (fresh.size === 0) return

        setCollapsed((current) => {
          const next = { ...current }
          for (const id of ids) next[id] = !fresh.has(id)
          return next
        })
      }, [snapshot, sessionId])

      React.useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => setNotice(null), 3000)
        return () => clearTimeout(timer)
      }, [notice])

      const startEdit = (item) => {
        const next = { id: item.id, original: item.text, draft: item.text }
        editingRef.current = next
        setEditing(next)
      }

      const changeDraft = (value) => {
        const current = editingRef.current
        if (!current) return
        const next = { ...current, draft: value }
        editingRef.current = next
        setEditing(next)
      }

      const cancelEdit = () => {
        editingRef.current = null
        setEditing(null)
      }

      const commitEdit = () => {
        const current = editingRef.current
        if (!current) return
        editingRef.current = null
        setEditing(null)

        const next = String(current.draft || '').trim()
        if (next.length === 0 || next === current.original) return
        if (next.length > MAX_TEXT) {
          setNotice(t('tooLong'))
          return
        }

        void saveItem(sessionId, current.id, next, current.original).then((outcome) => {
          if (outcome.ok) return
          if (outcome.code === 'conflict') setNotice(t('conflict'))
          else if (outcome.code === 'missing') setNotice(t('missing'))
          else if (outcome.code === 'http') setNotice(`${t('saveFailed')} (HTTP ${outcome.status})`)
          else setNotice(t('saveFailed'))
        })
      }

      const toggleNode = (key) => {
        setCollapsed((current) => ({ ...current, [key]: !current[key] }))
      }

      if (!sessionId) return h('div', { style: MUTED }, t('noSession'))
      if (snapshot.phase === 'loading') return h('div', { style: MUTED }, t('loading'))

      if (snapshot.phase === 'error') {
        return h(
          'div',
          { style: MUTED },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, t('readError')),
          h('div', { style: { opacity: 0.8 } }, snapshot.message),
          h('div', { style: { opacity: 0.6, marginTop: 6 } }, t('retrying')),
        )
      }

      const data = snapshot.data || {}
      const lists = data.lists || []
      const counts = data.counts || { done: 0, total: 0 }
      const allDone = counts.total > 0 && counts.done === counts.total

      if (lists.length === 0) {
        return h(
          'div',
          { style: MUTED },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, t('emptyTitle')),
          h('div', null, t('emptyHint')),
        )
      }

      const copyMarkdown = () => {
        const markdown = toMarkdown(data)
        if (!navigator.clipboard || !navigator.clipboard.writeText) {
          setNotice(t('noClipboard'))
          return
        }
        navigator.clipboard
          .writeText(markdown)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => setNotice(t('copyFailed')))
      }

      return h(
        'div',
        { style: { padding: '10px 12px', fontSize: 13, lineHeight: 1.5 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', marginBottom: 6, gap: 2 } },
          h('strong', { style: { fontSize: 13 } }, t('title')),
          h(
            'span',
            {
              style: {
                marginLeft: 6,
                opacity: allDone ? 1 : 0.62,
                color: allDone ? '#3fb950' : 'inherit',
                fontWeight: 400,
                fontVariantNumeric: 'tabular-nums',
              },
            },
            `${counts.done}/${counts.total}`,
          ),
          h('span', { style: { flex: 1 } }),
          counts.done > 0
            ? h(
                'button',
                { onClick: () => setHideDone((value) => !value), style: BUTTON, title: t('hideDoneHint') },
                hideDone ? t('showDone') : t('hideDone'),
              )
            : null,
          h(
            'button',
            { onClick: copyMarkdown, style: BUTTON, title: t('copyHint') },
            copied ? t('copied') : t('copy'),
          ),
        ),
        notice ? h('div', { style: { fontSize: 11, color: '#f85149', marginBottom: 6 } }, notice) : null,
        h(Progress, { done: counts.done, total: counts.total }),
        lists.map((list) =>
          h(List, {
            key: list.id,
            list,
            t,
            hideDone,
            collapsed,
            onToggleNode: toggleNode,
            editing,
            onStartEdit: startEdit,
            onDraft: changeDraft,
            onCommit: commitEdit,
            onCancel: cancelEdit,
          }),
        ),
      )
    }

    function apply(ctx) {
      report('apply-start', 'ctx=' + typeof ctx)

      try {
        // The locale service is optional: without it every string falls back to
        // English instead of crashing the panel.
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined

        ctx.inject(['sidebarRightTabs'], (owner) => {
          const tabs = owner.get('sidebarRightTabs')
          report('tabs-service', tabs ? 'present' : 'missing')
          if (!tabs) return

          owner.effect(
            () => tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              priority: 'extension',
              title: () => 'Checklist',
              guide: [{ id: 'checklist', order: 120, title: () => 'Checklist' }],
            }),
            'dsh-checklists: tab type',
          )
          report('tab-type', 'registered')

          const register = owner.slots.register.bind(owner.slots)
          owner.slots.inject('sidebar.right.pane.tab', () => register({
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
            inject: () => ({ locale }),
          }, ChecklistBody))
          report('tab-body', 'registered')
        })
      } catch (error) {
        report('apply-error', (error && (error.stack || error.message)) || String(error))
        throw error
      }
    }

    // Only REAL services go here: a static inject that never resolves parks the
    // plugin forever and `apply` never runs (this was the first bug). The tab
    // registry is picked up lazily above, exactly as dsh-image-gen does.
    return { apply, inject: ['slots', 'locale'] }
  },
})
