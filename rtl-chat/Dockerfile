# ── RTL Chat (Claude Agent SDK) ──────────────────────────────────────────
FROM node:20-slim

# bash + git: ה-SDK מריץ binary מובנה ומשתמש ב-/bin/bash לכלי Bash; git שימושי לכלים
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# התקנת תלויות (שכבה ננצלת מטמון)
COPY package*.json ./
RUN npm ci --omit=dev

# קוד האפליקציה
COPY . .

ENV NODE_ENV=production
# תיקיית עבודה לכלים (Bash/קבצים). נפרדת מקוד האפליקציה.
ENV WORKDIR=/workspace
RUN mkdir -p /workspace

EXPOSE 3000
CMD ["node", "server.js"]
