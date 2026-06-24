// ── מצב השיחה ──────────────────────────────────────────────────────────────
let history = []; // הודעות בפורמט ה-API: {role, content}
let busy = false;

const $ = (s) => document.querySelector(s);
const messagesEl = $('#messages');
const inputEl = $('#input');
const formEl = $('#composer');
const sendBtn = $('#send');
const modelEl = $('#model');

// ── אתחול ──────────────────────────────────────────────────────────────────
fetch('/api/config').then((r) => r.json()).then((cfg) => {
  if (cfg.defaultModel) modelEl.value = cfg.defaultModel;
  const line = $('#workdir-line');
  if (line) line.textContent = 'תיקיית עבודה: ' + cfg.workdir;
  if (!cfg.hasKey) showError('שים לב: לא הוגדר ANTHROPIC_API_KEY בשרת. הוסף אותו לקובץ .env והפעל מחדש.');
}).catch(() => {});

// ── עזרי תצוגה ───────────────────────────────────────────────────────────────
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function clearWelcome() {
  const w = messagesEl.querySelector('.welcome');
  if (w) w.remove();
}

// המרת Markdown בסיסי ל-HTML (בלוקי קוד, inline code, מודגש)
function renderMarkdown(text) {
  // escape
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // בלוקי קוד ```
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre><code>${code.replace(/\n$/, '')}</code></pre>`;
  });
  // inline code `...`
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // מודגש **...**
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

const toolIcons = {
  bash: '⚡', read_file: '📖', write_file: '✏️', edit_file: '🔧', list_dir: '📁',
};

function addToolCard(name) {
  const card = document.createElement('div');
  card.className = 'tool collapsed';
  card.innerHTML = `
    <div class="tool-head">
      <span class="icon">${toolIcons[name] || '🛠️'}</span>
      <span>הרצת כלי:</span>
      <span class="name">${name}</span>
      <span style="margin-inline-start:auto;color:var(--muted)">▼</span>
    </div>
    <div class="tool-body"></div>`;
  card.querySelector('.tool-head').addEventListener('click', () => card.classList.toggle('collapsed'));
  messagesEl.appendChild(card);
  scrollToBottom();
  return card;
}

// ── שליחת הודעה והזרמת התשובה ───────────────────────────────────────────────
async function sendMessage(text) {
  if (busy || !text.trim()) return;
  busy = true;
  sendBtn.disabled = true;

  addMessage('user').textContent = text;
  history.push({ role: 'user', content: text });

  let assistantBubble = null;
  let assistantText = '';
  let turnText = ''; // כל הטקסט של ה-assistant בסבב הזה (לשמירה בהיסטוריה)
  const ensureBubble = () => {
    if (!assistantBubble) {
      assistantBubble = addMessage('assistant');
      assistantBubble.classList.add('typing');
    }
    return assistantBubble;
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: history, model: modelEl.value }),
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
    showError('שגיאת תקשורת: ' + err.message);
  } finally {
    if (assistantBubble) assistantBubble.classList.remove('typing');
    // שמירת תשובת Claude בהיסטוריה כדי לשמר הקשר בין סבבים
    if (turnText.trim()) history.push({ role: 'assistant', content: turnText });
    busy = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }

  // ── טיפול באירוע בודד מה-stream ──
  function handleEvent(evt) {
    switch (evt.kind) {
      case 'text': {
        assistantText += evt.text;
        turnText += evt.text;
        const b = ensureBubble();
        b.innerHTML = renderMarkdown(assistantText);
        scrollToBottom();
        break;
      }
      case 'tool_input': {
        // סיים את בועת הטקסט הנוכחית (אם הייתה) ושמור אותה בהיסטוריה לוגית
        if (assistantBubble) {
          assistantBubble.classList.remove('typing');
          assistantBubble = null;
          assistantText = '';
        }
        const card = addToolCard(evt.name);
        const body = card.querySelector('.tool-body');
        const pretty = JSON.stringify(evt.input, null, 2);
        body.innerHTML = `<div style="color:var(--muted);font-size:11px;margin-bottom:4px">קלט:</div><pre>${escapeHtml(pretty)}</pre>`;
        card._body = body;
        currentToolCard = card;
        break;
      }
      case 'tool_result': {
        if (currentToolCard) {
          const body = currentToolCard._body;
          const out = String(evt.result);
          const trimmed = out.length > 4000 ? out.slice(0, 4000) + '\n… (קוצר)' : out;
          body.innerHTML += `<div style="color:var(--muted);font-size:11px;margin:8px 0 4px">פלט:</div><pre>${escapeHtml(trimmed)}</pre>`;
          currentToolCard = null;
        }
        scrollToBottom();
        break;
      }
      case 'done':
        break;
      case 'error':
        showError('שגיאה מהשרת: ' + evt.error);
        break;
    }
  }
}

let currentToolCard = null;

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── אירועי UI ────────────────────────────────────────────────────────────────
formEl.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = inputEl.value;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  sendMessage(text);
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    formEl.requestSubmit();
  }
});

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
});

$('#new-chat').addEventListener('click', () => {
  if (busy) return;
  history = [];
  messagesEl.innerHTML = '';
  const w = document.createElement('div');
  w.className = 'welcome';
  w.innerHTML = '<h2>שיחה חדשה ✨</h2><p>במה אפשר לעזור?</p>';
  messagesEl.appendChild(w);
});
