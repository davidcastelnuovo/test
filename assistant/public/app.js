import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── אתחול Supabase ──────────────────────────────────────────────────────
if (!window.SUPABASE_URL || window.SUPABASE_URL.includes('YOUR-PROJECT')) {
  alert('יש להגדיר את config.js עם פרטי ה-Supabase שלך (ראה config.example.js).');
}
const supabase = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

const $ = (s) => document.querySelector(s);
const authEl = $('#auth');
const layoutEl = $('#layout');
const messagesEl = $('#messages');
const conversationsEl = $('#conversations');
const inputEl = $('#input');

let currentConversationId = null;
let busy = false;

// ── אימות ────────────────────────────────────────────────────────────────
$('#auth-form').addEventListener('submit', (e) => { e.preventDefault(); signIn(); });
$('#signup-btn').addEventListener('click', signUp);
$('#logout').addEventListener('click', async () => { await supabase.auth.signOut(); });

async function signIn() {
  const { error } = await supabase.auth.signInWithPassword({
    email: $('#email').value.trim(),
    password: $('#password').value,
  });
  if (error) $('#auth-error').textContent = 'כניסה נכשלה: ' + error.message;
}

async function signUp() {
  const { error } = await supabase.auth.signUp({
    email: $('#email').value.trim(),
    password: $('#password').value,
  });
  $('#auth-error').textContent = error
    ? 'הרשמה נכשלה: ' + error.message
    : 'נרשמת! אם נדרש אימות אימייל — בדוק את תיבת הדואר, אחרת התחבר.';
}

// מעבר בין מצב מחובר/מנותק
supabase.auth.onAuthStateChange((_event, session) => {
  if (session?.user) showApp(session.user);
  else showAuth();
});

function showAuth() {
  authEl.classList.remove('hidden');
  layoutEl.classList.add('hidden');
}

async function showApp(user) {
  authEl.classList.add('hidden');
  layoutEl.classList.remove('hidden');
  $('#user-email').textContent = user.email || '';
  await loadConversations();
}

// ── שיחות ────────────────────────────────────────────────────────────────
async function loadConversations() {
  const { data, error } = await supabase
    .from('conversations')
    .select('id, title, updated_at')
    .order('updated_at', { ascending: false });
  if (error) return;
  conversationsEl.innerHTML = '';
  for (const c of data) {
    const item = document.createElement('div');
    item.className = 'session-item' + (c.id === currentConversationId ? ' active' : '');
    item.innerHTML = `<span class="stitle"></span><button class="del" title="מחק">🗑</button>`;
    item.querySelector('.stitle').textContent = c.title;
    item.querySelector('.stitle').addEventListener('click', () => openConversation(c.id));
    item.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); deleteConversation(c.id); });
    conversationsEl.appendChild(item);
  }
}

async function newConversation() {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('conversations')
    .insert({ user_id: user.id, title: 'שיחה חדשה' })
    .select('id')
    .single();
  if (error) return null;
  currentConversationId = data.id;
  await loadConversations();
  messagesEl.innerHTML = '';
  return data.id;
}

async function openConversation(id) {
  currentConversationId = id;
  await loadConversations();
  const { data, error } = await supabase
    .from('messages')
    .select('role, content')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true });
  if (error) return;
  messagesEl.innerHTML = '';
  for (const m of data) addMessage(m.role, m.content);
}

async function deleteConversation(id) {
  await supabase.from('conversations').delete().eq('id', id);
  if (id === currentConversationId) { currentConversationId = null; messagesEl.innerHTML = ''; }
  await loadConversations();
}

// ── הודעות ───────────────────────────────────────────────────────────────
function addMessage(role, content) {
  const w = messagesEl.querySelector('.welcome'); if (w) w.remove();
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = role === 'user' ? 'אתה' : 'עוזר';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = content;
  wrap.append(who, bubble);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function sendMessage(text) {
  if (busy || !text.trim()) return;
  busy = true;
  const { data: { user } } = await supabase.auth.getUser();
  if (!currentConversationId) await newConversation();

  // הודעת המשתמש
  addMessage('user', text);
  await supabase.from('messages').insert({
    conversation_id: currentConversationId, user_id: user.id, role: 'user', content: text,
  });

  // כותרת לשיחה חדשה לפי ההודעה הראשונה
  await supabase.from('conversations')
    .update({ title: text.slice(0, 40) })
    .eq('id', currentConversationId)
    .eq('title', 'שיחה חדשה');

  // ── placeholder עד שנחבר את הסוכן ──
  const placeholder = '🔧 הסוכן עדיין לא מחובר. בשלב הבא נחבר כאן את ה-AI שיגיב באמת.';
  addMessage('assistant', placeholder);
  await supabase.from('messages').insert({
    conversation_id: currentConversationId, user_id: user.id, role: 'assistant', content: placeholder,
  });

  await loadConversations();
  busy = false;
}

// ── אירועי UI ──────────────────────────────────────────────────────────────
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = inputEl.value;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  sendMessage(text);
});
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); }
});
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
});
$('#new-chat').addEventListener('click', () => { currentConversationId = null; messagesEl.innerHTML = ''; newConversation(); });
$('#toggle-sidebar').addEventListener('click', () => $('#sidebar').classList.toggle('hidden'));
