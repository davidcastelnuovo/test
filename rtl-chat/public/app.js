// ── מצב השיחה ──────────────────────────────────────────────────────────────
let sessionId = null;       // מזהה ה-session של ה-SDK — שומר הקשר בין סבבים
let busy = false;
let currentAbort = null;    // AbortController של הבקשה הפעילה (לעצירה)

const $ = (s) => document.querySelector(s);
const messagesEl = $('#messages');
const inputEl = $('#input');
const formEl = $('#composer');
const sendBtn = $('#send');
const modelEl = $('#model');
const sessionsEl = $('#sessions');

// ── אתחול ──────────────────────────────────────────────────────────────────
fetch('/api/config').then((r) => r.json()).then((cfg) => {
  if (cfg.defaultModel) modelEl.value = cfg.defaultModel;
  const line = $('#workdir-line');
  if (line) line.textContent = 'תיקיית עבודה: ' + cfg.workdir;
  if (!cfg.hasKey) showError('שים לב: לא הוגדר ANTHROPIC_API_KEY בשרת. הוסף אותו לקובץ .env והפעל מחדש.');
}).catch(() => {});

loadSessions();

// ── עזרי תצוגה ───────────────────────────────────────────────────────────────
function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function clearWelcome() { const w = messagesEl.querySelector('.welcome'); if (w) w.remove(); }
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function renderMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _l, code) => `<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return html;
}

function addMessage(role) {
  clearWelcome();
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = role === 'user' ? 'אתה' : 'Claude';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  wrap.appendChild(who);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom();
  return bubble;
}

function showError(msg) {
  clearWelcome();
  const box = document.createElement('div');
  box.className = 'error-box';
  box.textContent = msg;
  messagesEl.appendChild(box);
  scrollToBottom();
}

const toolIcons = { Bash: '⚡', Read: '📖', Write: '✏️', Edit: '🔧', Glob: '🔍', Grep: '🔎' };
const toolCards = new Map(); // id -> {card, body}

function addToolCard(id, name) {
  const card = document.createElement('div');
  card.className = 'tool collapsed';
  card.innerHTML = `
    <div class="tool-head">
      <span class="icon">${toolIcons[name] || '🛠️'}</span>
      <span>הרצת כלי:</span>
      <span class="name">${escapeHtml(name)}</span>
      <span style="margin-inline-start:auto;color:var(--muted)">▼</span>
    </div>
    <div class="tool-body"></div>`;
  card.querySelector('.tool-head').addEventListener('click', () => card.classList.toggle('collapsed'));
  messagesEl.appendChild(card);
  scrollToBottom();
  const body = card.querySelector('.tool-body');
  if (id) toolCards.set(id, { card, body });
  return { card, body };
}

function setToolInput(entry, input) {
  const pretty = JSON.stringify(input, null, 2);
  entry.body.innerHTML = `<div class="tool-label">קלט:</div><pre>${escapeHtml(pretty)}</pre>`;
}
function setToolResult(entry, result, isError) {
  const out = String(result || '');
  const trimmed = out.length > 4000 ? out.slice(0, 4000) + '\n… (קוצר)' : out;
  entry.body.innerHTML += `<div class="tool-label">${isError ? 'פלט (שגיאה):' : 'פלט:'}</div><pre>${escapeHtml(trimmed)}</pre>`;
  if (isError) entry.card.classList.add('tool-error');
}

function addThinkingBlock() {
  const block = document.createElement('div');
  block.className = 'thinking collapsed';
  block.innerHTML = `
    <div class="thinking-head">💭 <span>חשיבה</span>
      <span style="margin-inline-start:auto;color:var(--muted)">▼</span></div>
    <div class="thinking-body"></div>`;
  block.querySelector('.thinking-head').addEventListener('click', () => block.classList.toggle('collapsed'));
  messagesEl.appendChild(block);
  scrollToBottom();
  return block.querySelector('.thinking-body');
}

// ── ניהול כפתור שלח/עצור ──────────────────────────────────────────────────
function setBusy(on) {
  busy = on;
  if (on) {
    sendBtn.textContent = 'עצור';
    sendBtn.classList.add('stop');
    sendBtn.disabled = false;
  } else {
    sendBtn.textContent = 'שלח';
    sendBtn.classList.remove('stop');
    sendBtn.disabled = false;
  }
}

// ── שליחת הודעה והזרמת התשובה ───────────────────────────────────────────────
async function sendMessage(text) {
  if (!text.trim()) return;
  setBusy(true);

  addMessage('user').textContent = text;

  let assistantBubble = null;
  let assistantText = '';
  let thinkingBody = null;
  const ensureBubble = () => {
    if (!assistantBubble) {
      assistantBubble = addMessage('assistant');
      assistantBubble.classList.add('typing');
    }
    return assistantBubble;
  };

  currentAbort = new AbortController();
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: text, model: modelEl.value, sessionId }),
      signal: currentAbort.signal,
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        let evt;
        try { evt = JSON.parse(data); } catch { continue; }
        handleEvent(evt);
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      const note = document.createElement('div');
      note.className = 'muted';
      note.style.cssText = 'text-align:center;font-size:12px;margin:4px 0';
      note.textContent = '— נעצר —';
      messagesEl.appendChild(note);
    } else {
      showError('שגיאת תקשורת: ' + err.message);
    }
  } finally {
    if (assistantBubble) assistantBubble.classList.remove('typing');
    currentAbort = null;
    setBusy(false);
    inputEl.focus();
    loadSessions(); // רענון רשימת ההיסטוריה (נוצרה/עודכנה שיחה)
  }

  function handleEvent(evt) {
    switch (evt.kind) {
      case 'session':
        sessionId = evt.sessionId;
        break;
      case 'thinking': {
        if (!thinkingBody) thinkingBody = addThinkingBlock();
        thinkingBody.textContent += evt.text;
        scrollToBottom();
        break;
      }
      case 'text': {
        thinkingBody = null; // חשיבה הסתיימה לסבב הזה
        assistantText += evt.text;
        const b = ensureBubble();
        b.innerHTML = renderMarkdown(assistantText);
        scrollToBottom();
        break;
      }
      case 'tool_start': {
        if (assistantBubble) { assistantBubble.classList.remove('typing'); assistantBubble = null; assistantText = ''; }
        thinkingBody = null;
        addToolCard(evt.id, evt.name);
        break;
      }
      case 'tool_input': {
        const entry = toolCards.get(evt.id) || addToolCard(evt.id, evt.name);
        setToolInput(entry, evt.input);
        break;
      }
      case 'tool_result': {
        const entry = toolCards.get(evt.id);
        if (entry) setToolResult(entry, evt.result, evt.isError);
        scrollToBottom();
        break;
      }
      case 'done': break;
      case 'error': showError('שגיאה מהשרת: ' + evt.error); break;
    }
  }
}

// ── היסטוריית שיחות ──────────────────────────────────────────────────────────
async function loadSessions() {
  try {
    const list = await (await fetch('/api/sessions')).json();
    if (!Array.isArray(list)) return;
    sessionsEl.innerHTML = '';
    for (const s of list) {
      const item = document.createElement('div');
      item.className = 'session-item' + (s.id === sessionId ? ' active' : '');
      item.innerHTML = `<span class="stitle">${escapeHtml(s.title)}</span><button class="del" title="מחק">🗑</button>`;
      item.querySelector('.stitle').addEventListener('click', () => openSession(s.id));
      item.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); deleteSession(s.id); });
      sessionsEl.appendChild(item);
    }
  } catch { /* התעלם */ }
}

async function openSession(id) {
  if (busy) return;
  try {
    const { items } = await (await fetch(`/api/sessions/${id}/messages`)).json();
    sessionId = id;
    toolCards.clear();
    messagesEl.innerHTML = '';
    renderHistory(items || []);
    loadSessions();
  } catch (err) {
    showError('טעינת השיחה נכשלה: ' + err.message);
  }
}

async function deleteSession(id) {
  try {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (id === sessionId) startNewChat();
    loadSessions();
  } catch { /* התעלם */ }
}

// רנדור של שיחה שמורה מהפורמט השטוח שהשרת מחזיר
function renderHistory(items) {
  clearWelcome();
  let lastAssistant = null;
  for (const it of items) {
    if (it.type === 'user') { addMessage('user').textContent = it.text; lastAssistant = null; }
    else if (it.type === 'assistant') {
      if (!lastAssistant) lastAssistant = addMessage('assistant');
      lastAssistant.innerHTML = renderMarkdown((lastAssistant._raw = (lastAssistant._raw || '') + it.text));
    }
    else if (it.type === 'thinking') { const b = addThinkingBlock(); b.textContent = it.text; lastAssistant = null; }
    else if (it.type === 'tool_use') { const e = addToolCard(it.id, it.name); setToolInput(e, it.input); lastAssistant = null; }
    else if (it.type === 'tool_result') {
      const e = toolCards.get(it.id);
      if (e) setToolResult(e, it.result, it.isError);
      lastAssistant = null;
    }
  }
  scrollToBottom();
}

function startNewChat() {
  sessionId = null;
  toolCards.clear();
  messagesEl.innerHTML = '';
  const w = document.createElement('div');
  w.className = 'welcome';
  w.innerHTML = '<h2>שיחה חדשה ✨</h2><p>במה אפשר לעזור?</p>';
  messagesEl.appendChild(w);
  loadSessions();
}

// ── אירועי UI ────────────────────────────────────────────────────────────────
formEl.addEventListener('submit', (e) => {
  e.preventDefault();
  if (busy) { // הכפתור במצב "עצור"
    if (currentAbort) currentAbort.abort();
    return;
  }
  const text = inputEl.value;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  sendMessage(text);
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); formEl.requestSubmit(); }
});
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
});

$('#new-chat').addEventListener('click', () => { if (!busy) startNewChat(); });
$('#toggle-sidebar').addEventListener('click', () => $('#sidebar').classList.toggle('hidden'));
