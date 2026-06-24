import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

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

  try {
    const stream = query({
      prompt,
      options: {
        model: model || DEFAULT_MODEL,
        systemPrompt: SYSTEM_PROMPT,
        cwd: WORKDIR,
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
    send({ kind: 'error', error: err?.message || String(err) });
  } finally {
    res.end();
  }
});

app.get('/api/config', (_req, res) => {
  res.json({ defaultModel: DEFAULT_MODEL, workdir: WORKDIR, hasKey: !!API_KEY });
});

app.listen(PORT, () => {
  console.log(`\n🟢 RTL Chat (Claude Agent SDK) רץ על http://localhost:${PORT}`);
  console.log(`📂 תיקיית עבודה: ${WORKDIR}\n`);
});
