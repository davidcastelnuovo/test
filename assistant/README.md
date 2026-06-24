# עוזר · Vercel + Supabase (בסיס, ללא סוכן)

הבסיס של העוזר: ממשק עברית RTL, **התחברות והיסטוריית שיחות אמיתיות** — frontend סטטי על **Vercel** שמדבר ישירות מול **Supabase** (Auth + Postgres), בלי קוד שרת. RLS מגן על הנתונים כך שכל משתמש רואה רק את שלו.

> השלב הזה **בלי סוכן AI** בכוונה. הוא מקים את כל התשתית (אימות, DB, פריסה) כדי שנחבר אליה את הסוכן בשלב הבא — סוכן שיתחבר גם למערכת ה-CRM שלך וגם לאפליקציה הזו.

## ארכיטקטורה

```
Vercel (frontend סטטי)  ──►  Supabase (Auth + Postgres, מוגן ב-RLS)
```
אין שרת ביניים. ה-`supabase-js` בדפדפן מבצע את הכל. (הסוכן, בהמשך, יהיה החלק היחיד שירוץ בצד-שרת.)

## הקמה

### 1. Supabase
1. צור פרויקט ב-[supabase.com](https://supabase.com).
2. **SQL Editor** → הדבק את `supabase/migrations/0001_init.sql` → **Run**. (יוצר טבלאות `profiles`/`conversations`/`messages` + RLS.)
3. **Project Settings → API** → העתק את `Project URL` ואת `anon public key`.

### 2. קונפיג מקומי
```bash
cp public/config.example.js public/config.js
# ערוך את public/config.js עם ה-URL וה-anon key
```
(ה-`anon key` ציבורי ומיועד לצד-לקוח — RLS הוא ההגנה.)

### 3. הרצה מקומית
כל שרת סטטי, למשל:
```bash
npx serve public
```
פתח את הכתובת, הירשם, והתחל שיחה.

## פריסה ל-Vercel
1. דחוף ל-GitHub.
2. ב-Vercel: **New Project** → בחר את הריפו → **Root Directory = `assistant`**.
3. אין build (פרויקט סטטי). ודא ש-`public/config.js` קיים — או הוסף אותו דרך הריפו/הסקריפט, מכיוון שהוא ב-`.gitignore`. (חלופה: הפוך אותו לקובץ שמיוצר ב-build מתוך משתני סביבה.)
4. Deploy → תקבל URL.

## הסכמה
| טבלה | תיאור |
|------|-------|
| `profiles` | שורה לכל משתמש (נוצרת אוטומטית בהרשמה) |
| `conversations` | שיחות פר-משתמש (כותרת, זמן עדכון) |
| `messages` | הודעות (`role`, `content`, `cost_usd`) |

כל הטבלאות עם RLS: `auth.uid()` חייב להתאים ל-`user_id`.

## מה הלאה (הסוכן)
כשנרצה, נוסיף רכיב צד-שרת (Vercel Function או קונטיינר) שמריץ **Messages API + tool use**, עם כלים שמתחברים ל-Supabase ול-CRM שלך, וכותב את התשובות חזרה לטבלת `messages`.
