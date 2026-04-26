# Collaboration Platform Deployment

## סקירה כללית

הפרויקט מפריס פלטפורמת שיתוף פעולה מבוססת קוד פתוח על שרת Ubuntu בענן, עם **Rocket.Chat** לצ'אט ארגוני ו-**Jitsi Meet** לוידאו, שניהם חשופים ב-HTTPS בכתובות משנה ייעודיות. **אימות משתמשים** ממומש בצורה מרכזית באמצעות **Google OAuth 2.0** ושירות Node.js שמנפק JWT ל-Jitsi, יחד עם **Nginx** כ-reverse proxy ו-**Let’s Encrypt (Certbot)** לתעודות TLS. התצורה מבוססת **Docker** ו-**Docker Compose** ומופרדת בין רכיבים לפי תיקיות, עם ערכי רגישות בקבצי `.env` שאינם נכללים במאגר.

## דרישות המטלה

- Rocket.Chat בכתובת `chat.think-deploy.com` (או שקולה)
- Jitsi Meet בכתובת `video.think-deploy.com` (או שקולה)
- בקרת גישה / אימות ארגוני באמצעות **Google SSO / OAuth2**
- אופציונלי: אינטגרציית **SMTP** להתראות ושחזור סיסמה
- אופציונלי: **ניטור ותצפית** עם Grafana ו-Loki (ובפרויקט זה גם Prometheus ו-Promtail)

## סטטוס מימוש

| דרישה | סטטוס | הערות |
|--------|--------|--------|
| Rocket.Chat (צ'אט) | הושלם | `rocketchat/docker-compose.yml` — MongoDB + Rocket.Chat, `ROOT_URL` ל-`https://chat.think-deploy.com` |
| Jitsi Meet (וידאו) | הושלם | `jitsi/docker-compose.yml` — מחסנית jitsi-docker, אימות JWT |
| Google OAuth / SSO | הושלם (וידאו) / חלקי (צ'אט) | **וידאו:** שירות `auth/` (Passport Google) מנפק JWT שמתאים ל-Jitsi. **צ'אט:** אין קובצי Git עם OAuth מוכן; מומלץ להשלים OAuth/הגבלת דומיין דרך ממשק ניהול Rocket.Chat |
| אינטגרציית SMTP | לא מומש / דולג | לא הוגדר SMTP ל-Rocket.Chat או שירותים אחרים |
| Grafana, Loki, ניטור | הושלם | `monitoring/docker-compose.yml` — Loki, Promtail, Grafana, Prometheus, Node Exporter. Nginx ל-Grafana: `grafana.think-deploy.com` |

**סיכום קצר:** Rocket.Chat, Jitsi, שירות האימות ל-Google+JWT, Nginx, TLS ו-Docker — פועלים לפי התצורה בפרויקט. SMTP לא מומש. מחסנית ניטור (Grafana/Loki/…) קיימת בקבצי הפרויקט ונפרסה בהתאם לסביבה.

## ארכיטקטורת המערכת

- **מערכת הפעלה:** Ubuntu על מופע VM בענן.
- **קונטיינרים:** Docker Engine ו-Docker Compose לשירותים: Rocket.Chat+MongoDB, Jitsi (web, prosody, jicofo, jvb, …), שירות `auth` (Node.js), ואופציונלית מחסנית `monitoring`.
- **Nginx:** reverse proxy ל-HTTPS, מפנה כל תת-דומיין לפורט מקומי (127.0.0.1) של השירות המתאים.
- **Let’s Encrypt / Certbot:** תעודות TLS ל-`chat`, `video`, `auth`, `grafana` (לפי הצורך).
- **Rocket.Chat + MongoDB:** אחסון ויישום צ'אט.
- **Jitsi Meet:** WebRTC, עם אימות **JWT** (מאומת מול `JWT_APP_SECRET` ב-`.env` של Jitsi).
- **שירות אימות (Node.js):** אימות Google OAuth, ללא session — לאחר login מונפק JWT (אותו סוד ומבנה claim כפי ש-Jitsi מצפה) והפניה לכניסה לוידאו.
- **Google:** ספק זהויות (Identity Provider) לפי OAuth 2.0.

### דיאגרמת ASCII (לפי הפריסה בפועל)

```
                    Internet
                        |
                        v
              DNS (למשל Cloudflare)
                        |
                        v
            Nginx (Reverse Proxy) + TLS 443
                        |
     +------------------+--------------------+------------------+
     |                  |                    |                  |
     v                  v                    v                  v
chat.think-deploy.com  video...        auth...          grafana...
     |                  |                    |                  |
     v                  v                    v                  v
 Rocket.Chat:3000   Jitsi web:8000   Node auth:3001   Grafana:3002
 (Docker)            (Docker)         (Docker)         (Docker)
  |                    |                    |
 MongoDB                |                    +-------> Google OAuth
 (Docker)                \
                           +--> (JWT מאומת ב-Prosody/Jitsi)
```

**הערה:** שירותי Jitsi הנוספים (JVB, Prosody, Jicofo וכו') רצים ב-Docker אך לא הוצגו בדיאגרמה כדי לשמור על קריאות.

## קישורים למערכות

- **Rocket.Chat:** [https://chat.think-deploy.com](https://chat.think-deploy.com)
- **Jitsi Meet:** [https://video.think-deploy.com](https://video.think-deploy.com)
- **שירות אימות (אם מופעל):** [https://auth.think-deploy.com](https://auth.think-deploy.com)
- **Grafana (אופציונלי, אם הופעל):** [https://grafana.think-deploy.com](https://grafana.think-deploy.com)

## רכיבי הפרויקט

- **Rocket.Chat:** שרת צ'אט; תלוי ב-MongoDB עם replica set (כפי שמוגדר ב-`rocketchat/docker-compose.yml`). חשוף ב-`ROOT_URL` לכתובת הציבורית.
- **Jitsi Meet:** התקנת `docker-jitsi-meet`; `AUTH_TYPE=jwt` ו-`ENABLE_AUTH=1` לאימות דרך JWT שנחתם על ידי שירות `auth` (וההגדרות ב-`.env` חייבות להתאים).
- **Nginx:** קבצי דוגמה תחת `nginx/sites-available/`. בשרת: קישור מ-`sites-enabled`, בדיקה עם `nginx -t`, וטעינה מחדש.
- **Certbot / Let’s Encrypt:** הנפקת תעודות לתת-הדומיינים; Nginx מוגדר לנתיבי `fullchain.pem` / `privkey.pem` תחת `/etc/letsencrypt/live/<שם>`.
- **Google OAuth:** אפליקציית Web ב-Google Cloud; Redirect URI: `https://auth.think-deploy.com/auth/google/callback`. מזהים וסודות נמצאים ב-**משתני סביבה בלבד**.
- **Docker Compose:** כל stack עם `docker-compose.yml` (או שם שקול) נפרד; אין קובץ אחד שמריץ הכל — נוח לתחזוקה ולפריסה הדרגתית.
- **`.env.example`:** בתיקיית השורש, ב-`auth/app/`, ב-`monitoring/`, וב-`jitsi/.env.production.example` (בנוסף ל-`jitsi/env.example` המקורי) — רק **פלייס-הולדרים** ללא סודות אמיתיים.

## שלבי התקנה ופריסה

1. **התקנת כלים על השרת (דוגמה — Ubuntu):**
   ```bash
   sudo apt update
   sudo apt install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx git
   sudo usermod -aG docker "$USER"   # נדרש logout/login
   ```
2. **שכפול המאגר (לאחר העלאה ל-GitHub):**
   ```bash
   git clone <YOUR_REPO_URL>
   cd comm-platform
   ```
3. **העתקת קבצי סביבה:**  
   - `cp auth/app/.env.example auth/app/.env`  
   - `cp jitsi/.env.production.example jitsi/.env` (ולערוך לפי `jitsi/env.example` לפרטים נוספים)  
   - `cp monitoring/.env.example monitoring/.env` (אם משתמשים ב-Grafana)  
   - `cp rocketchat/.env.example rocketchat/.env` (אם נדרש)
4. **מילוי משתנים ב-`.env`:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `JWT_SECRET` (ו-**אותו ערך** עבור `JWT_APP_SECRET` ב-Jitsi), דומיינים, `PUBLIC_URL` ל-Jitsi, ועוד.
5. **הרצת שירותים (מתוך כל תיקייה, לפי הסדר):**
   ```bash
   cd rocketchat && docker compose up -d
   cd ../jitsi && docker compose up -d
   cd ../auth/app && docker compose up -d
   cd ../monitoring && docker compose up -d   # אופציונלי
   ```
6. **Nginx:** להעתיק/להתאים את `nginx/sites-available/*.conf` ל-`/etc/nginx/sites-available/`, ליצור קישורי `sites-enabled`, `sudo nginx -t`, `sudo systemctl reload nginx`.
7. **TLS:** `sudo certbot --nginx -d chat.think-deploy.com -d video.think-deploy.com -d auth.think-deploy.com` (ו-`grafana` אם רלוונטי).
8. **אימות בדפדפן:** כניסה ל-`https://chat...` ו-`https://video...` לאחר התחלת Jitsi ו-Rocket Chat; בדיקת flow OAuth ב-`https://auth.../auth/google`.

**חשוב (Jitsi):** בפתיחת אש בחומת אש/קבוצת אבטחה יש לאפשר בדרך כלל TCP 80/443, **UDP 10000** למדיה, ו-SSH. התאם ל-IP הציבורי (למשל `JVB_ADVERTISE_IPS`).

## Google OAuth / SSO

- ב-Google Cloud Console נוצרה אפליקציית OAuth (סוג *Web application*).
- הוגדר **Redirect URI** מדויק: `https://auth.think-deploy.com/auth/google/callback` — כל אי-התאמה תגרום לשגיאת `redirect_uri_mismatch`.
- `GOOGLE_CLIENT_ID` ו-`GOOGLE_CLIENT_SECRET` נשמרים ב-`auth/app/.env` (לא ב-Git).
- ה-flow: המשתמש מגיע ל-`/auth/google` → Google → callback → המערכת מנפקת JWT ומפנה ל-Jitsi עם ה-JWT.
- **לא יש לשמור** אישורי OAuth, מפתחות JWT או סיסמאות admin במאגר.

פלייס-הולדרים אופייניים:

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
JWT_SECRET=
ALLOWED_DOMAIN=
```

(שימוש ב-`ALLOWED_DOMAIN` מומלץ כהרחבה עתידית לסינון דומיין מייל — הקוד ב-`auth/app/app.js` מסתמך כיום על מדיניות Google והגדרת האפליקציה.)

## אתגרים ובעיות שנתקלנו בהן

1. **Docker Compose ורישיון הפקודה**  
   **בעיה:** בחלק מהשרתים אין `docker compose` (פלאגין) או שגרסה ישנה.  
   **פתרון:** התקנת `docker-compose-plugin` מה-pkg של Docker, או שימוש ב-`docker-compose` עצמאי (בינארי) אם הדבר נדרש במדיניות הארגון. לאחר מכן `docker compose version` לאימות.

2. **Nginx ו-HTTPS למספר תת-דומיינים**  
   **בעיה:** כל שירות מאזין בפורט שונה על localhost; הדפדפן חייב לראות 443 אחד עם SNI.  
   **פתרון:** `server` נפרד לכל `server_name`, `proxy_pass` ל-`127.0.0.1:PORT` המתאים, Certbot מוסיף בלוקי SSL.

3. **התאמת callback של Google OAuth**  
   **בעיה:** התחברות נכשלת אם ה-URL ב-Google Cloud לא תואם בדיוק לנתיב בשרת.  
   **פתרון:** עדכון ה-redirect ל-`https://auth.think-deploy.com/auth/google/callback` והשארת `callbackURL` בקוד זהה (ראו `auth/app/app.js`).

4. **מורכבות אימות ב-Jitsi**  
   **בעיה:** Jitsi אינו מחובר "מהקופסה" ל-SaaS Google Login; האימות הארגוני נעשה בד"כ ב-JWT או LDAP וכו'.  
   **פתרון:** שירות חיצוני (Node) שמבצע Google OAuth, חותם JWT שמתאים ל-`JWT_APP_ID` / `JWT_APP_SECRET` / issuers/audiences ב-Prosody, ואז Jitsi מאמת את ה-JWT. משתמשים מגיעים לדף כניסה/redirect שמזין את הדפדפן לחדר עם הטוקן (למשל flow עם `/test?jwt=...` לפי המימוש).

5. **משתני סביבה וסודות**  
   **בעיה:** דליפת מפתחות ל-Git מסכנת את כל מערכת האימות.  
   **פתרון:** `.env` מקומי, `.env.example` עם פלייס-הולדרים, ו-`.gitignore` שמונע commit של `.env` ומפתחות.

6. **חומת אש ורשת**  
   **בעיה:** וידאו ללא UDP או IP שגוי מפרסם שובת שיחה/שליטה.  
   **פתרון:** פתיחת UDP 10000, והגדרת `JVB_ADVERTISE_IPS` לפי כתובת ציבורית אם ה-VM מאחורי NAT.

7. **DNS**  
   **בעיה:** Let’s Encrypt ו-Google redirect דורשים ש-DNS (A/AAAA) יצביעו לשרת לפני אימות.  
   **פתרון:** יצירת רשומות ל-`chat`, `video`, `auth` (ו-`grafana`).

## אבטחה

- סודות נשמרים ב-`.env` בלבד, והקבצים האלה **אינם** במאגר.
- **HTTPS** מופעל לכל הכניסות הציבוריות.
- **אין** שמירה על אישורי מנהל Rocket.Chat / Grafana במאגר.
- **OAuth** ו-JWT מופיעים ב-Git רק כדוגמאות ריקות (`…example`).
- **`.gitignore`** מיישם את הכללים לעיל (כולל `node_modules`, לוגים, `.pem`, `letsencrypt/`, וכו').

## Credentials

**אין** שמירה על אישורי מנהל או סיסמאות במאגר. אם נדרש ביקורת (review) חיצונית, יש לשלוח אישורים בערוץ מוצמד ו**לא** לשמור ב-GitHub.

## מה לא מומש

- **SMTP** (מייל להתראות, איפוס סיסמה, וכו') — **לא** הוגדר; יש לתעד בבירור בפרויקט הפרודקשן אם/when מוסיפים.
- **מגבלת דומין ארגוני ב-Rocket.Chat** — לא הוטמעה כקונפיגורציית Git; מומלץ להשלים דרך OAuth/ SAML או מדיניות ב-Google.
- **שירות `auth`:** אין סינון לפי `ALLOWED_DOMAIN` בקוד הנוכחי (אפשרי כשיפור עתידי).

## בדיקות שבוצעו

```bash
docker ps
docker compose ps
sudo nginx -t
systemctl status nginx
curl -I https://chat.think-deploy.com
curl -I https://video.think-deploy.com
curl -I https://auth.think-deploy.com
```

לפי הצורך:
```bash
journalctl -u nginx -e
docker logs <container_name>
```

## מבנה תיקיות

```
comm-platform/
├── .env.example                 # אינדקס הפניה לכל קבצי .env.example
├── .gitignore
├── README.md
├── nginx/
│   └── sites-available/         # דוגמאות vhost (chat, video, auth, grafana)
├── rocketchat/
│   ├── docker-compose.yml       # MongoDB + Rocket.Chat
│   ├── .env.example
│   └── ...                      # עוד קבצי upstream/קומפוזיציה
├── jitsi/
│   ├── docker-compose.yml
│   ├── env.example
│   ├── .env.production.example
│   └── ...                      # מקור jitsi-docker
├── auth/
│   ├── app/
│   │   ├── app.js              # Google OAuth + JWT ל-Jitsi
│   │   ├── Dockerfile
│   │   ├── docker-compose.yml
│   │   └── .env.example
│   └── node_modules/            # לא ב-Git (התקנה מקומית אם מפתחים מחוץ ל-Docker)
└── monitoring/
    ├── docker-compose.yml
    ├── prometheus/
    ├── loki/
    ├── promtail/
    └── .env.example
```

## סיכום

הפרויקט ממחיש פריסה **production-style** של כלי שיתוף פעולה בקוד פתוח: Rocket.Chat, Jitsi Meet, חשיפה מאובטחת ב-HTTPS, אינטגרציית **זהויות** עם **Google OAuth** ו-**JWT** לווידאו, שכבת **Nginx** אחורית, אוטומציית **תעודות** עם **Let’s Encrypt**, וארגון **קונפיגורציה** סביב **Docker Compose** וקבצי **סביבה** — בלי לכלול סודות במאגר, בהתאם לנהוג ב-DevOps מודרני.
