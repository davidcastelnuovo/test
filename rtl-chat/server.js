import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'claude-sonnet-4-6';
// תיקיית העבודה שבה כל הכלים פועלים (sandbox פשוט)
const WORKDIR = path.resolve(process.env.WORKDIR || process.cwd());

if (!API_KEY) {
  console.error('\n⚠️  חסר ANTHROPIC_API_KEY. צור קובץ .env (ראה .env.example) ושים שם את המפתח.\n');
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── הגדרת הכלים שנחשפים ל-Claude ─────────────────────────────────────────
const TOOLS = [
  {
    name: 'bash',
    description: 'הרצת פקודת shell בתיקיית העבודה. מחזיר stdout ו-stderr.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'הפקודה להרצה' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'קריאת תוכן של קובץ טקסט (יחסית לתיקיית העבודה).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'כתיבת קובץ (יוצר או דורס). יחסית לתיקיית העבודה.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'החלפת מחרוזת בקובץ. old_string חייב להיות ייחודי בקובץ.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'list_dir',
    description: 'הצגת רשימת קבצים ותיקיות בנתיב נתון (ברירת מחדל: תיקיית העבודה).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: [],
    },
  },
];

// מוודא שנתיב נשאר בתוך WORKDIR (הגנה בסיסית מ-path traversal)
function safePath(p) {
  const resolved = path.resolve(WORKDIR, p || '.');
  if (resolved !== WORKDIR && !resolved.startsWith(WORKDIR + path.sep)) {
    throw new Error('הגישה מחוץ לתיקיית העבודה חסומה: ' + p);
  }
  return resolved;
}

// ── מימוש הכלים בצד השרת ──────────────────────────────────────────────────
async function runTool(name, input) {
  try {
    switch (name) {
      case 'bash': {
        const { stdout, stderr } = await execAsync(input.command, {
          cwd: WORKDIR,
          timeout: 120000,
          maxBuffer: 10 * 1024 * 1024,
        });
        return (stdout || '') + (stderr ? '\n[stderr]\n' + stderr : '') || '(אין פלט)';
      }
      case 'read_file': {
        const content = await fs.readFile(safePath(input.path), 'utf8');
        return content || '(קובץ ריק)';
      }
      case 'write_file': {
        const target = safePath(input.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, input.content, 'utf8');
        return `נכתב בהצלחה: ${input.path} (${input.content.length} תווים)`;
      }
      case 'edit_file': {
        const target = safePath(input.path);
        const content = await fs.readFile(target, 'utf8');
        const occurrences = content.split(input.old_string).length - 1;
        if (occurrences === 0) throw new Error('המחרוזת לא נמצאה בקובץ');
        if (occurrences > 1) throw new Error(`המחרוזת מופיעה ${occurrences} פעמים — חייבת להיות ייחודית`);
        await fs.writeFile(target, content.replace(input.old_string, input.new_string), 'utf8');
        return `נערך בהצלחה: ${input.path}`;
      }
      case 'list_dir': {
        const dir = safePath(input.path || '.');
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries.map((e) => (e.isDirectory() ? '📁 ' : '📄 ') + e.name).join('\n') || '(תיקייה ריקה)';
      }
      default:
        throw new Error('כלי לא מוכר: ' + name);
    }
  } catch (err) {
    return `שגיאה: ${err.message}`;
  }
}

const SYSTEM_PROMPT = `אתה עוזר קוד מועיל שעובד בעברית. ענה תמיד בעברית, בצורה ברורה ותמציתית.
יש לך כלים להרצת פקודות shell ולקריאה/כתיבה/עריכה של קבצים בתיקיית העבודה של המשתמש.
השתמש בכלים כשצריך לבצע משימות בפועל. הסבר בקצרה מה אתה עושה.
תיקיית העבודה הנוכחית היא: ${WORKDIR}`;

// ── קריאה ל-Anthropic API עם streaming ────────────────────────────────────
async function streamAnthropic(model, messages, onEvent) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
      stream: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text}`);
  }

  // אוסף את ההודעה של ה-assistant מתוך אירועי ה-SSE
  const blocks = []; // {type, text} | {type:'tool_use', id, name, inputJson}
  let stopReason = null;
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

      if (evt.type === 'content_block_start') {
        const cb = evt.content_block;
        if (cb.type === 'text') blocks[evt.index] = { type: 'text', text: '' };
        else if (cb.type === 'tool_use') {
          blocks[evt.index] = { type: 'tool_use', id: cb.id, name: cb.name, inputJson: '' };
          onEvent({ kind: 'tool_start', name: cb.name });
        }
      } else if (evt.type === 'content_block_delta') {
        const b = blocks[evt.index];
        if (evt.delta.type === 'text_delta') {
          b.text += evt.delta.text;
          onEvent({ kind: 'text', text: evt.delta.text });
        } else if (evt.delta.type === 'input_json_delta') {
          b.inputJson += evt.delta.partial_json;
        }
      } else if (evt.type === 'message_delta') {
        if (evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
      }
    }
  }

  // בונה את תוכן ההודעה של ה-assistant בפורמט של ה-API
  const assistantContent = blocks.filter(Boolean).map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    return { type: 'tool_use', id: b.id, name: b.name, input: b.inputJson ? JSON.parse(b.inputJson) : {} };
  });

  return { assistantContent, stopReason };
}

// ── נקודת הקצה לצ'אט: לולאת agent עם streaming ל-SSE ──────────────────────
app.post('/api/chat', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'חסר ANTHROPIC_API_KEY בשרת' });
  }
  const { messages, model } = req.body;
  const useModel = model || DEFAULT_MODEL;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const convo = [...messages]; // היסטוריית השיחה בפורמט ה-API

  try {
    let safety = 0;
    while (safety++ < 25) {
      const { assistantContent, stopReason } = await streamAnthropic(useModel, convo, send);
      convo.push({ role: 'assistant', content: assistantContent });

      if (stopReason === 'tool_use') {
        const toolResults = [];
        for (const block of assistantContent) {
          if (block.type !== 'tool_use') continue;
          send({ kind: 'tool_input', name: block.name, input: block.input });
          const result = await runTool(block.name, block.input);
          send({ kind: 'tool_result', name: block.name, result });
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        }
        convo.push({ role: 'user', content: toolResults });
        continue; // עוד סבב — Claude יראה את תוצאות הכלים
      }
      break; // אין יותר קריאות לכלים
    }
    send({ kind: 'done' });
  } catch (err) {
    send({ kind: 'error', error: err.message });
  } finally {
    res.end();
  }
});

app.get('/api/config', (_req, res) => {
  res.json({ defaultModel: DEFAULT_MODEL, workdir: WORKDIR, hasKey: !!API_KEY });
});

app.listen(PORT, () => {
  console.log(`\n🟢 RTL Chat רץ על http://localhost:${PORT}`);
  console.log(`📂 תיקיית עבודה: ${WORKDIR}\n`);
});
