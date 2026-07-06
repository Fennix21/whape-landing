# WHAPE — Mapa del proyecto (leer antes de explorar)

Plataforma que enseña a convertir problemas en negocios que venden por WhatsApp.
Comunidad + academia + misiones de 21 días + CRM + bot. Premium S/99 pago único.

## Stack (no explorar: es esto)
- **Vercel serverless** + Node **CommonJS**. SIN package.json, SIN build, SIN dependencias, SIN TypeScript. `fetch` global.
- BD = **Upstash Redis** vía REST (helper `redis(cmd)` duplicado en cada api/*.js; comando como array).
- Frontend = HTML sueltos con CSS/JS inline (sin framework). `vercel.json`: cleanUrls, redirects (/club y /comunidad → /academia), maxDuration 30 para whatsapp.js y community.js, 2 crons → /api/cron (12:00 y 03:00 UTC) + cron externo horario (cron-job.org).
- **Deploy = `git push` a main** (repo Fennix21/whape-landing). Producción: **https://www.whape.club** (el apex responde 308 → usar www en curls).

## Archivos
| Archivo | Qué es |
|---|---|
| `index.html` | Landing previa: conteo regresivo del año, **recibo interactivo del día** (dormir/trabajo/comer/celular con −/+, ids `v*`/`d*`/`m*`, funciones `csAdj/csRender/fillMath`), **círculo vicioso** (`.cyc-*`), CTA → /reto |
| `reto.html` | Landing conversacional (chat con opciones, SIEMPRE 2-3 botones). Fork final: Premium S/99 → wa.me `(premium)` / Gratis → wa.me `(gratis)` |
| `calculadora.html` | Lead magnet: costo del scroll (wizard → resultado + compartir). Fuente `(calculadora)` |
| `registro-comunidad.html` | Pitch de la comunidad |
| `academia.html` | App de miembros. Toggle 3 secciones `goSection('grupos'|'comunidad'|'academia')` (`segGru/segCom/segAca`, título dinámico `topTitle`). Feed estilo Skool (posts con aprobación, likes, comentarios, niveles `lvl`, ranking). Grupos = misiones 21 días (`gInit/gRender/gHomeHtml`, diagnóstico `GQ`, check-in racha+comodín, muro Premium día 8+, graduación/mentores). API vía `api(action,data)` → /api/community |
| `panel.html` | CRM del dueño (pass = WHAPE_ADMIN_PASS). Barra: Embudo(kanban), 📥 Bandeja(badge), 🗣️ Feed(aprobar posts), 🎯 Grupos, ✍️ Copy(entrenador+estructuras `PLANTILLAS`+archivo), 💡 Ideas, 🎯 Foco, ⋯Más(Analíticas/📚Comunidad-contenido/Progreso/⚙️Bot), ↻, 🚪. `capi(sub,extra)` → community admin; `api(action,extra)` → crm.js |
| `track.js` | Mini analítica (pageview + clicks data-ev) → /api/track |
| `api/whatsapp.js` | Webhook Meta (GET verify token, POST mensajes). **VER ORDEN DE BLOQUES abajo** |
| `api/crm.js` | Backend panel: list/get/send(24h→error 131047)/status/rename/note/tags/remind/gettemplates/settemplates/getwtemplates/sendtemplate/pause/clearchat/delete/stats/setnotify/get-set-resetprompt |
| `api/community.js` | Academia+comunidad+grupos. Miembro: signup/login/resetpw/forgotemail/me/academy/complete/seen/lesson/rate/feedback/myfeedback/setemail/updateprofile/setavatar/changepw/notifications/marknotifseen/feed/feedpost/feeddel/feedlike/feedcomment/feedcommentdel/leaderboard/ggroup/gdiag/gjoin/gcheckin/gwait/ggraduate/gmentor. **Admin** (action:'admin'+pass, sub:): tree/setcfg/upload/academystats/memberprogress/inbox*/setfblabels/savemod/delmod/savelesson/dellesson/feedlist/feedpin/feedapprove/feeddel/setcats/glist/gsave/gdel/gmembers/gsetpremium/gmentorset/greset/idealist/ideadone/ideadel/copycoach/swipelist/swipesave/swipedel/radarlist/focostatus/focoset/fococlear/focoreset/tareaadd/tareadel/aprendel/assisthist/assistclear |
| `api/cron.js` | Diario: flushDueReminders, scanGroupRisk (3+ días sin check-in → aviso dueño, 1 vez por caída), weeklyRadar (lunes, IA, guarda en `radars`), dailyGym (reto de copy), socio (apertura si hora Perú<12 / cierre si ≥18), refocusPing (horas 15,16,17,18,21 Perú → abre sesión `refocus`). Tiene su propio waFormat/notifyOwner/askAI |
| `api/_prompt.js` | DEFAULT_PROMPT del vendedor. ⚠️ El prompt VIVO está en Redis `config:prompt` (panel → ⚙️ Bot); editar _prompt.js no cambia el bot hasta "Restaurar original" |
| `api/_coach.js` | Motor coach-core compilado (tool `registrar_objetivo`, strict:true válido). **NO editar** salvo pedido explícito |
| `api/_reminders.js`, `api/img.js`, `api/media.js`, `api/track.js` | Recordatorios, imágenes Redis, media de WhatsApp, analítica |

## api/whatsapp.js — orden de bloques del POST (crítico al insertar)
1. Idempotencia `msg.id` (tras `getLead`) → 2. `(unlock:)`/texto libre de desbloqueo/`(recuperar)` y markers de tags → **BLOQUES DEL DUEÑO** (cada uno verifica `config:ownerphone`, responde y `return`): 3. 💡 ideas (`idea/anota/apunta/guarda/💡`, tolera saludos) → 4. 🎓 `maestro:`/`copy:` → 5. 🤝 socio (`hoy:/logré:/aprendí:/tarea:/foco/debería:`) → 6. 🎛️ `modo [asistente|vendedor]` → 7. 🧭 refocus (sesión socrática activa 45min o `disperso`; salir: `listo`) → 8. 🤖 **asistente catch-all** (si `config:ownermode`≠vendedor, el dueño NUNCA baja de aquí; memoria `assist:hist`, datos frescos AL FINAL del prompt prevalecen) → 9. guard **coach** (`lead.tags` incluye 'coach' o `lead.mode==='coach'` → `runCoachFlow`, persiste `lead.objetivos[]`, WIP 3) → 10. bot vendedor `askClaude(history12, getPrompt())`.
- `sendWhatsApp(to,body)` aplica **waFormat** (negrita WhatsApp = *uno*; convierte **/##/viñetas; quita asteriscos huérfanos). `notifyOwner(text,from)`. `askAIRaw(system,user,maxTok)` = Haiku, devuelve '' si falla.

## Claves Redis
`lead:<phone>` {phone,name,status,paused,tags[],source,messages[≤300 {role,text,ts,human?,media?}],objetivos[],lastMsgId} · `leads` ZSET · `member:<phone>` {name,salt,hash,email,avatar,points,premium} · `members` SET · `academy:modules` · `progress:<phone>` · `unlocked:<phone>` SET · `academy:inbox` · `community:posts` SET + `post:<id>` {cat,approved,likedBy,comments} (cat `g:<gid>` = feed de grupo, excluido del feed general) · `mentors` SET · `config:groups` · `gstate:<phone>` {groupId,streak,lastCheckinDay,graceWeek,checkins,graduated,mentorApplied,riskDay} · `waitlist:<gid>` · `diag:<phone>` · `ideas` · `tareas` · `foco` {date,task,done} · `foco:streak` · `foco:hist` · `aprendizajes` · `swipefile` · `radars` · marcadores 1/día: `gym:last, socio:am, socio:pm, radar:last, refocus:ping` · `refocus` (sesión) · `assist:hist` · `config:{prompt,notify,ownerphone,ownermode,fblabels,emailpopup,club_grouplink,club_watext,community_cats,socio,refocus,gym}` (los 3 últimos: '0' apaga)

## Env vars (Vercel)
WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_VERIFY_TOKEN · ANTHROPIC_API_KEY (+ ANTHROPIC_API_KEY_COACH opcional) · UPSTASH_REDIS_REST_URL/TOKEN (o KV_REST_API_*) · WHAPE_ADMIN_PASS · WHAPE_OWNER_PHONE · WHAPE_BOT_MODEL (def. claude-opus-4-8) · WHAPE_AI_MODEL (def. claude-haiku-4-5-20251001) · WHAPE_COACH_MODEL/WIP/PROMPT · WHAPE_SECRET · RESEND_API_KEY/RESEND_FROM · CRON_SECRET

## Reglas de trabajo
- **Verificar antes de commit**: `node --check` a cada .js tocado; para HTML: extraer `<script>` inline y `node --check` + contar `<div>`/`</div>` iguales.
- **Modales del panel**: al crear uno nuevo, añadir su id a LOS DOS selectores CSS de modales (display:none / .open) + botón en barra + funciones con `capi`.
- **Dueño = 51960838350** (`config:ownerphone`): modo asistente por defecto. Sus pruebas del vendedor: `modo vendedor`. Los flujos coach/vendedor NUNCA lo alcanzan en modo asistente.
- **E2E en prod**: simular webhook con `curl -X POST https://www.whape.club/api/whatsapp` y payload Meta `{entry:[{changes:[{value:{contacts:[{profile:{name}}],messages:[{from,id,type:'text',text:{body}}]}}]}]}`. Cuenta de pruebas: `51900000099`. La pass de admin está en `C:\Users\CORDOVA\whape-sync\config.json` (leerla de ahí, jamás pedirla ni imprimirla).
- **Puntos comunidad = participación**: post aprobado +1, comentario +1, graduación +5; likes NO dan puntos. Posts nacen `approved:false` (se aprueban en panel → Feed, con aviso WhatsApp al dueño).
- Hora Perú = UTC-5 (`new Date(Date.now()-5*3600000)`); día de cohorte con `cohortDay(startStr)`.
- Estilo del código existente: ES5-ish en frontend (var, funciones con nombre), español en comentarios y UI, emojis en labels.

## Fuera del repo (no buscar aquí dentro)
- `C:\Users\CORDOVA\whape-sync\` → puente CRM→Obsidian (sync.js diario 8:30am, vault "The Game Of Time", frontmatter minúsculas tema/estado/creada) + config.json (pass) + cron-ping.vbs.
- Tareas Windows: "WHAPE Obsidian Sync" (8:30am), "WHAPE Cron Hora" (horario). Cron externo: cron-job.org "Cronjob WHAPE" → /api/cron cada hora (America/Lima).
- App Android antigua (claves/activación) archivada en `..\OYE-app-archivo\` para la futura marca OYE.

## Recetas rápidas
- **Nuevo comando del dueño por WhatsApp** → bloque regex en whatsapp.js DESPUÉS del bloque socio y ANTES del asistente catch-all; verificar owner; `return` temprano.
- **Nueva acción admin** → community.js dentro de `action==='admin'`; el panel la llama con `capi('sub',{...})`.
- **Nuevo mensaje programado** → función en cron.js con marcador `X:last` (1/día) e integrarla al handler; el cron externo ya pega cada hora.
- **Textos del bot vendedor** → editar en panel ⚙️ Bot (Redis), no en _prompt.js.
