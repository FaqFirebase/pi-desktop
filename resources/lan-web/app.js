/* Pi Desktop LAN remote — mobile chat client */
;(() => {
  const $ = (id) => document.getElementById(id)

  const loginScreen = $('login')
  const chatScreen = $('chat')
  const tokenInput = $('token-input')
  const loginBtn = $('login-btn')
  const loginError = $('login-error')
  const messagesEl = $('messages')
  const promptEl = $('prompt')
  const sendBtn = $('send-btn')
  const abortBtn = $('abort-btn')
  const logoutBtn = $('logout-btn')
  const piStatusEl = $('pi-status')
  const wsNameEl = $('ws-name')

  const STORAGE_KEY = 'pi_lan_token'
  let token = localStorage.getItem(STORAGE_KEY) || ''
  let es = null
  let streaming = false
  let streamBubble = null

  function authHeaders() {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { ...authHeaders(), ...(opts.headers || {}) },
    })
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = { raw: text }
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || res.statusText || 'Request failed')
      err.status = res.status
      err.data = data
      throw err
    }
    return data
  }

  function showLogin(errMsg) {
    chatScreen.hidden = true
    loginScreen.hidden = false
    if (errMsg) {
      loginError.hidden = false
      loginError.textContent = errMsg
    } else {
      loginError.hidden = true
    }
    if (es) {
      es.close()
      es = null
    }
  }

  function showChat() {
    loginScreen.hidden = true
    chatScreen.hidden = false
  }

  function setStatus(text, cls) {
    piStatusEl.textContent = text
    piStatusEl.className = 'status ' + (cls || 'muted')
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function addBubble(role, text, opts = {}) {
    const div = document.createElement('div')
    div.className = 'bubble ' + role + (opts.thinking ? ' thinking' : '')
    if (opts.meta) {
      const meta = document.createElement('div')
      meta.className = 'meta'
      meta.textContent = opts.meta
      div.appendChild(meta)
    }
    const body = document.createElement('div')
    body.className = 'body'
    body.textContent = text
    div.appendChild(body)
    if (opts.streaming) {
      const cur = document.createElement('span')
      cur.className = 'stream-cursor'
      body.appendChild(cur)
    }
    messagesEl.appendChild(div)
    scrollToBottom()
    return { root: div, body }
  }

  function extractTextFromMessage(msg) {
    if (!msg || typeof msg !== 'object') return ''
    const content = msg.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
  }

  function extractThinking(msg) {
    if (!msg || !Array.isArray(msg.content)) return ''
    return msg.content
      .filter((b) => b && b.type === 'thinking' && typeof b.thinking === 'string')
      .map((b) => b.thinking)
      .join('')
  }

  async function loadMessages() {
    messagesEl.innerHTML = ''
    streamBubble = null
    try {
      const data = await api('/api/messages')
      // Pi may return { messages: [...] } or nested data
      const list =
        (data && data.data && data.data.messages) ||
        (data && data.messages) ||
        (Array.isArray(data) ? data : [])
      if (!Array.isArray(list) || list.length === 0) {
        addBubble('system', 'No messages yet. Say hi.')
        return
      }
      for (const msg of list) {
        const role = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : 'system'
        const thinking = extractThinking(msg)
        if (thinking) addBubble('assistant', thinking, { thinking: true, meta: 'Thinking' })
        const text = extractTextFromMessage(msg).trim()
        if (text) {
          const meta =
            role === 'assistant' && (msg.model || msg.provider)
              ? [msg.provider, msg.model].filter(Boolean).join(' · ')
              : undefined
          addBubble(role, text, { meta })
        }
      }
    } catch (err) {
      if (err.status === 401) {
        logout('Session expired — sign in again')
        return
      }
      addBubble('system', 'Could not load history: ' + err.message)
    }
  }

  async function refreshStatus() {
    try {
      const data = await api('/api/status')
      const st = data.pi && data.pi.status
      if (data.workspace && data.workspace.name) {
        wsNameEl.textContent = data.workspace.name
      }
      if (st === 'running') setStatus('Pi running', 'live')
      else if (st === 'starting') setStatus('Pi starting…', 'busy')
      else setStatus(st || 'stopped', st === 'error' ? 'err' : 'muted')
    } catch (err) {
      if (err.status === 401) logout('Unauthorized')
      else setStatus('offline', 'err')
    }
  }

  function connectEvents() {
    if (es) es.close()
    const url = '/api/events?token=' + encodeURIComponent(token)
    es = new EventSource(url)
    es.addEventListener('ready', () => {
      setStatus('live', 'live')
    })
    es.addEventListener('pi', (ev) => {
      let data
      try {
        data = JSON.parse(ev.data)
      } catch {
        return
      }
      handlePiEvent(data)
    })
    es.onerror = () => {
      setStatus('reconnecting…', 'busy')
    }
  }

  function handlePiEvent(ev) {
    if (!ev || typeof ev !== 'object') return
    const t = ev.type

    if (t === 'status_change') {
      if (ev.status === 'running') setStatus('Pi running', 'live')
      else setStatus(String(ev.status || 'unknown'), ev.status === 'error' ? 'err' : 'muted')
      return
    }

    if (t === 'agent_start') {
      streaming = true
      abortBtn.hidden = false
      setStatus('working…', 'busy')
      return
    }

    if (t === 'agent_end') {
      streaming = false
      abortBtn.hidden = true
      if (streamBubble) {
        const cur = streamBubble.body.querySelector('.stream-cursor')
        if (cur) cur.remove()
        streamBubble = null
      }
      setStatus('Pi running', 'live')
      return
    }

    // Assistant stream deltas
    if (t === 'message_update' || t === 'message_delta') {
      const delta = ev.assistantMessageEvent
      if (!delta) return
      if (delta.type === 'text_delta' && typeof delta.delta === 'string') {
        if (!streamBubble) {
          streamBubble = addBubble('assistant', '', { streaming: true })
        }
        const cur = streamBubble.body.querySelector('.stream-cursor')
        if (cur) {
          streamBubble.body.insertBefore(document.createTextNode(delta.delta), cur)
        } else {
          streamBubble.body.appendChild(document.createTextNode(delta.delta))
        }
        scrollToBottom()
      }
      if (delta.type === 'thinking_delta' && typeof delta.delta === 'string') {
        // Append to a dashed thinking bubble
        let think = messagesEl.querySelector('.bubble.thinking.stream')
        if (!think) {
          const b = addBubble('assistant', delta.delta, { thinking: true, meta: 'Thinking' })
          b.root.classList.add('stream')
        } else {
          think.querySelector('.body').textContent += delta.delta
          scrollToBottom()
        }
      }
      return
    }

    if (t === 'tool_execution_start') {
      addBubble('system', 'Tool: ' + (ev.toolName || '…'))
    }
  }

  async function sendPrompt() {
    const message = promptEl.value.trim()
    if (!message || streaming) return
    promptEl.value = ''
    autosize()
    addBubble('user', message)
    streaming = true
    abortBtn.hidden = false
    sendBtn.disabled = true
    try {
      await api('/api/prompt', { method: 'POST', body: JSON.stringify({ message }) })
      setStatus('working…', 'busy')
    } catch (err) {
      streaming = false
      abortBtn.hidden = true
      addBubble('system', 'Send failed: ' + err.message)
      if (err.status === 401) logout('Unauthorized')
    } finally {
      sendBtn.disabled = false
    }
  }

  async function abort() {
    try {
      await api('/api/abort', { method: 'POST', body: '{}' })
    } catch (err) {
      addBubble('system', 'Abort failed: ' + err.message)
    }
  }

  async function login() {
    const t = tokenInput.value.trim()
    if (!t) {
      loginError.hidden = false
      loginError.textContent = 'Token required'
      return
    }
    loginBtn.disabled = true
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Invalid token')
      }
      token = t
      localStorage.setItem(STORAGE_KEY, token)
      showChat()
      await refreshStatus()
      await loadMessages()
      connectEvents()
    } catch (err) {
      showLogin(err.message)
    } finally {
      loginBtn.disabled = false
    }
  }

  function logout(msg) {
    token = ''
    localStorage.removeItem(STORAGE_KEY)
    showLogin(msg)
  }

  function autosize() {
    promptEl.style.height = 'auto'
    promptEl.style.height = Math.min(promptEl.scrollHeight, 140) + 'px'
  }

  // Wire UI
  loginBtn.addEventListener('click', () => void login())
  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void login()
  })
  sendBtn.addEventListener('click', () => void sendPrompt())
  abortBtn.addEventListener('click', () => void abort())
  logoutBtn.addEventListener('click', () => logout())
  promptEl.addEventListener('input', autosize)
  promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendPrompt()
    }
  })

  // Boot
  if (token) {
    showChat()
    refreshStatus()
      .then(() => loadMessages())
      .then(() => connectEvents())
      .catch(() => logout('Could not reconnect'))
  } else {
    showLogin()
  }

  // Prefill token from query for QR / deep links
  const q = new URLSearchParams(location.search)
  if (q.get('token') && !token) {
    tokenInput.value = q.get('token')
  }
})()
