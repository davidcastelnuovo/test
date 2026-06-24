import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query, listSessions, getSessionMessages, deleteSession, renameSession } from '@anthropic-ai/claude-agent-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'claude-sonnet-4-6';
// תיקיית העבודה שבה הכלים (Bash/קבצים) פועלים
const WORKDIR = path.resolve(process.env.WORKDIR || process.cwd());

if (!API_KEY) {
  console.error('\n⚠️  חסר ANTHROPIC_API_KEY. צור קובץ .env (ראה .env.example) ושים שם את המפתח.\n');
}

const app = express();

// ── הגנת סיסמה אופציונלית (HTTP Basic) ─────────────────────────────────────
// חובה לחשיפה ציבורית: האפליקציה מריצה פקודות על השרת. הגדר AUTH_USER ו-AUTH_PASS
// בסביבה כדי להפעיל. ללא הגדרה — אין הגנה (מתאים רק להרצה מקומית).
const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;
if (AUTH_USER && AUTH_PASS) {
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
      if (u === AUTH_USER && p === AUTH_PASS) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="rtl-chat"');
    return res.status(401).send('נדרש אימות');
  });
  console.log('🔒 הגנת סיסמה פעילה (AUTH_USER/AUTH_PASS)');
} else {
  console.log('⚠️  אין הגנת סיסמה — אל תחשוף לאינטרנט בלי להגדיר AUTH_USER ו-AUTH_PASS');
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SYSTEM_PROMPT = `אתה עוזר קוד מועיל שעובד בעברית. ענה תמיד בעברית, בצורה ברורה ותמציתית.
יש לך כלים להרצת פקודות shell, חיפוש, וקריאה/כתיבה/עריכה של קבצים בתיקיית העבודה של המשתמש.
השתמש בכלים כשצריך לבצע משימות בפועל, והסבר בקצרה מה אתה עושה.
תיקיית העבודה הנוכחית היא: ${WORKDIR}`;

// כלים מובנים של ה-SDK שנרשה (סגנון Claude Code)
const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];

// ── נקודת הקצה לצ'אט: מריץ את מנוע ה-agent של ה-SDK ומזרים ל-SSE ──────────
app.post('/api/chat', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'חסר ANTHROPIC_API_KEY בשרת' });
  }
  const { prompt, model, sessionId } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // מפה בין tool_use id לשם הכלי, כדי לשייך תוצאות לקריאות
  const toolNames = new Map();

  // עצירה: אם הלקוח מתנתק (לחיצה על "עצור" מבטלת את ה-fetch) — נבטל את ה-query.
  // משתמשים ב-res.on('close') ולא ב-req: האחרון נורה גם כשגוף הבקשה נקרא במלואו.
  const abortController = new AbortController();
  let aborted = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      aborted = true;
      abortController.abort();
    }
  });

  try {
    const stream = query({
      prompt,
      options: {
        model: model || DEFAULT_MODEL,
        systemPrompt: SYSTEM_PROMPT,
        cwd: WORKDIR,
        abortController,
        allowedTools: ALLOWED_TOOLS,
        // אישור אוטומטי של הכלים המורשים ללא אישור אינטראקטיבי.
        // עדיף על permissionMode:'bypassPermissions' כי הדגל --dangerously-skip-permissions
        // נחסם בהרצה כ-root, ו-canUseTool עובד בכל מצב.
        canUseTool: async (name, input) =>
          ALLOWED_TOOLS.includes(name)
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: `הכלי ${name} אינו מורשה בממשק זה` },
        includePartialMessages: true, // מאפשר streaming של טקסט וקריאות כלים
        ...(sessionId ? { resume: sessionId } : {}),
      },
    });

    for await (const message of stream) {
      switch (message.type) {
        case 'system':
          if (message.subtype === 'init') {
            send({ kind: 'session', sessionId: message.session_id });
          }
          break;

        case 'stream_event': {
          const evt = message.event;
          if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
            toolNames.set(evt.content_block.id, evt.content_block.name);
            send({ kind: 'tool_start', id: evt.content_block.id, name: evt.content_block.name });
          } else if (evt.type === 'content_block_delta') {
            if (evt.delta.type === 'text_delta') {
              send({ kind: 'text', text: evt.delta.text });
            } else if (evt.delta.type === 'thinking_delta') {
              send({ kind: 'thinking', text: evt.delta.thinking });
            }
          }
          break;
        }

        case 'assistant': {
          // הודעה מלאה — נשתמש בה כדי לשלוח את הקלט המלא של קריאות כלים
          for (const block of message.message.content || []) {
            if (block.type === 'tool_use') {
              send({ kind: 'tool_input', id: block.id, name: block.name, input: block.input });
            }
          }
          break;
        }

        case 'user': {
          // הודעת user מכילה את תוצאות הכלים שהורצו
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                const text = Array.isArray(block.content)
                  ? block.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('')
                  : String(block.content ?? '');
                send({
                  kind: 'tool_result',
                  id: block.tool_use_id,
                  name: toolNames.get(block.tool_use_id) || '',
                  result: text,
                  isError: !!block.is_error,
                });
              }
            }
          }
          break;
        }

        case 'result':
          send({ kind: 'done', subtype: message.subtype, cost: message.total_cost_usd, turns: message.num_turns });
          break;
      }
    }
  } catch (err) {
    // ביטול יזום (עצירה) אינו שגיאה אמיתית
    if (!aborted) send({ kind: 'error', error: err?.message || String(err) });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

app.get('/api/config', (_req, res) => {
  res.json({ defaultModel: DEFAULT_MODEL, workdir: WORKDIR, hasKey: !!API_KEY });
});

// ── היסטוריית שיחות (נשמרת ע"י ה-SDK כ-JSONL) ─────────────────────────────
app.get('/api/sessions', async (_req, res) => {
  try {
    const sessions = await listSessions({ dir: WORKDIR, limit: 100 });
    res.json(
      sessions.map((s) => ({
        id: s.sessionId,
        title: s.customTitle || s.summary || s.firstPrompt || 'שיחה ללא כותרת',
        lastModified: s.lastModified,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// מחזיר את הודעות השיחה בפורמט שטוח שה-frontend יודע לרנדר
app.get('/api/sessions/:id/messages', async (req, res) => {
  try {
    const msgs = await getSessionMessages(req.params.id, { dir: WORKDIR });
    const items = [];
    for (const m of msgs) {
      const content = m.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'text' && m.type === 'user') items.push({ type: 'user', text: block.text });
        else if (block.type === 'text' && m.type === 'assistant') items.push({ type: 'assistant', text: block.text });
        else if (block.type === 'thinking') items.push({ type: 'thinking', text: block.thinking });
        else if (block.type === 'tool_use') items.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        else if (block.type === 'tool_result') {
          const text = Array.isArray(block.content)
            ? block.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('')
            : String(block.content ?? '');
          items.push({ type: 'tool_result', id: block.tool_use_id, result: text, isError: !!block.is_error });
        }
      }
    }
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.patch('/api/sessions/:id', async (req, res) => {
  try {
    const title = String(req.body?.title || '').trim();
    if (!title) return res.status(400).json({ error: 'כותרת ריקה' });
    await renameSession(req.params.id, title, { dir: WORKDIR });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  try {
    await deleteSession(req.params.id, { dir: WORKDIR });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`\n🟢 RTL Chat (Claude Agent SDK) רץ על http://localhost:${PORT}`);
  console.log(`📂 תיקיית עבודה: ${WORKDIR}\n`);
});
