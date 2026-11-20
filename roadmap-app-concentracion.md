# Roadmap de Desarrollo — App de Concentración
## Arquitectura Back-end First

> **Principio rector:** el back-end es la fuente única de verdad; el front-end es capa de presentación y ejecución sensorial. Se guardan **timestamps y eventos**, no contadores. Solo vive en el cliente lo que es físicamente imposible server-side: tick del reloj, reproducción de audio, notificaciones locales programadas y Service Worker.

---

## FASE 0: Fundamentos del Back-end
- Setup del servidor (Node/Express o similar) + base de datos
- Modelo de dominio: Usuario, Sesión, Ciclo, Tarea, Estadística, Preferencia
- API REST versionada (`/api/v1`)
- Sistema de autenticación por **deviceId** (UUID anónimo)
  - Middleware de auth con interfaz `AuthProvider` (base extensible)
  - Endpoint de registro/recuperación de deviceId
  - Endpoint `/me` para validar identidad
  - *Nota: la capa de auth queda abstraída para poder añadir OAuth/email en el futuro sin tocar la lógica de negocio. Por ahora solo se implementa `deviceId`.*
- Sincronización de reloj (endpoint `/time`, offset server-client)
- Estructura de eventos (log inmutable para sesiones y tareas)

---

## FASE 1: Cronómetro (Back como autoridad)
**Back-end:**
- Endpoint `POST /sessions` que precomputa el plan completo aplicando reglas
- Almacenamiento de `plan`, `startedAt`, `accumulatedPauseMs`, `currentIndex`
- Cálculo de `endsAt` por fase
- Validación autoritativa de tiempos personalizados (rango, coherencia)
- Endpoints de control **solo para eventos que rompen el plan**: `pause`, `resume`, `skip`, `reset`, `end`
- `POST /sessions` devuelve **el plan completo + `version`** en una sola respuesta
- Sin endpoints por transición de fase (no hay `POST /sessions/:id/next-phase`)

**Front-end:**
- Render del cronómetro usando `remaining = endsAt - now(offsetServer)`
- Selector de tiempo (20, 25, 30, 60, custom)
- Validación de entrada en cliente (feedback inmediato) + validación autoritativa en back
- Indicador visual del tiempo seleccionado
- Guarda el plan en memoria al iniciar sesión
- Avanza por el plan **localmente** sin consultar al back
- Solo llama al back en eventos significativos (ver contrato de sincronización)
- Si `version` del back cambia, re-fetch del plan

---

## FASE 2: Ciclos y Descansos (sin round-trip por fase)
**Back-end:**
- Reglas de descanso: 25-40 min → 5 min; 40+ min → 10 min; descanso largo (20 min) cada 4 ciclos
- La secuencia completa se genera **en `POST /sessions`**, no por fase
- Contador de ciclos derivado de `currentIndex` del plan (el back lo usa solo para estadísticas finales)

**Front-end:**
- Detección local de fin de fase (compara `endsAt` con `now`)
- Transición automática **sin petición**
- Notificación local programada al iniciar cada fase (respaldo offline)
- Indicador visual de Estudio/Descanso y ciclo N/M

---

## FASE 3: Sistema de Audio
**Back-end:**
- Servir archivos de audio (CDN o streaming)
- Política de volumen por fase en preferencias de usuario (normal en focus, bajo en break)

**Front-end:**
- Reproducción continua y loop automático
- Fade in/out y control manual de volumen
- Sonidos de notificación en transiciones (inicio descanso, fin descanso, fin ciclo) — **locales**
- Aplicar la política de volumen que dicta el back
- Precarga del audio para evitar cortes

---

## FASE 4: Contrato de Sincronización por Eventos
*(Reemplaza LocalStorage/IndexedDB como persistencia primaria)*

### 4A. Contrato de sincronización (front ↔ back)

#### Front → Back: solo en eventos significativos

| Evento | ¿Llama al back? | Por qué |
|---|---|---|
| Inicio de sesión | ✅ Sí (una vez) | El back genera el plan y devuelve `sessionId` + `plan` + `version` |
| Transición de fase (focus→break) | ❌ **No** | El plan ya lo contiene; el front solo renderiza |
| Cada segundo / cada minuto | ❌ **No** | El reloj es local (`endsAt - now`) |
| Pausa / resume | ✅ Sí | Es un evento real de estado (`accumulatedPauseMs` cambia) |
| Skip manual de fase | ✅ Sí | Rompe el plan original |
| Reset de sesión | ✅ Sí | Invalida el plan |
| Fin de sesión completa | ✅ Sí (una vez) | Cierra la sesión y alimenta estadísticas |
| Cambio de preferencias (tiempo, volumen) | ✅ Sí | Invalida el plan si cambia el tiempo |
| CRUD de tareas | ✅ Sí (por acción) | Datos autoritativos |
| Abrir vista de tareas / pantalla de inicio | ✅ Sí (una vez) | `GET /tasks/primordial` — pull bajo demanda, ya pre-computado en back |
| Descartar primordial ("No es primordial") | ✅ Sí | Setea `priorityDismissedUntil`, alimenta el feedback loop |
| Cambios menores de UI (volumen momentáneo, mute) | ❌ No | Solo local |
| `visibilitychange` / cierre de pestaña | ✅ Sí (flush batch) | Vaciar cola de eventos pendientes |
| Sync periódico de respaldo | ✅ Opcional (cada 1h) | Solo si hay eventos en cola |

**Regla:** si el evento no cambia el estado autoritativo del back, no viaja. La transición de fase **no cambia el plan** — solo mueve `currentIndex`, que el front puede calcular solo.

#### Back → Front: solo cuando es estrictamente necesario

| Disparador | ¿Empuja al front? |
|---|---|
| Login / inicio de sesión | ✅ Sí (el front hace pull inicial) |
| Cambio de preferencias desde **otro dispositivo** | ✅ Sí (WebSocket o push, solo si hay multi-dispositivo activo) |
| Notificación de fin de fase (PWA) | ✅ Sí (push nativo, es su razón de existir) |
| Actualización de estadísticas | ❌ No (pull bajo demanda al abrir dashboard) |
| Cambio de prioridad por reglas/IA | ❌ No por defecto (el front hace pull al abrir la vista; solo push si hay multi-dispositivo activo) |
| Cambio en tareas desde otro dispositivo | ⚠️ Solo si el usuario tiene la app abierta en 2+ dispositivos |
| Sync horario de respaldo | ⚠️ Opcional, pull del cliente (no push del servidor) |

**Reglas:**
- El back **no empuja estado por defecto**. Solo empuja cuando (a) el front no puede saberlo solo, o (b) el usuario lo pidió explícitamente (push notifications, dashboard abierto).
- El recálculo de prioridad es un evento del back, nunca del front: el front no dispara recálculos, solo lee resultados.

### 4B. Implementación

**Back-end:**
- Base de datos real como fuente de verdad
- Preferencias (tiempo preferido, volumen, notificaciones) por usuario
- Estado de sesión autoritativo (`currentIndex`, fase actual, `accumulatedPauseMs`)
- `POST /sessions` idempotente por `sessionId` (reintentos no duplican)
- Endpoint `/sync` que aplica cola de **eventos idempotentes** (`eventId` + `version`)
- Endpoint `/sessions/:id/state` **solo bajo demanda** (al recuperar conexión, no periódicamente)
- Sin WebSocket por defecto. Si se añade multi-dispositivo, el WebSocket **solo transporta cambios de preferencias/tareas**, nunca ticks de reloj

**Front-end:**
- Caché local (IndexedDB) con la última copia conocida del estado
- Cola de eventos pendientes con idempotencia
- Flush de cola en: cierre de sesión, `visibilitychange`, cada 1h como máximo, o al recuperar conexión
- **Nunca** sincroniza en cada fase
- Reconciliación con `version`: si el back tiene versión mayor → pull del estado; si es igual → aplicar cola local

---

## FASE 5: Sistema de Tareas (To-Do List)
**Back-end:**
- CRUD completo (`POST/GET/PATCH/DELETE`)
- Persistencia por usuario
- Contadores pendientes/completadas calculados en servidor
- Cada mutación de tarea (crear, editar fecha, completar, reabrir) dispara el recálculo de prioridad de Fase 6.5A (sin bloquear la respuesta: se encola)

**Front-end:**
- UI de gestión de tareas
- Optimistic updates (marcar completada antes de confirmación, rollback si falla)
- Sincronización con cola de eventos

---

## FASE 6: Funciones Avanzadas de Tareas
**Back-end:**
- Prioridades (alta/media/baja) y ordenamiento en servidor
- Edición, categorías/etiquetas, fecha límite (opcional)
- Filtros y búsqueda por servidor (query params)

**Front-end:**
- Selector de prioridad con código de colores
- UI para etiquetas y fecha límite
- Render del orden que manda el back

---

## FASE 6.5: Priorización Automática de Tareas (Reglas + IA)

> Objetivo: cuando el usuario abra la app, las tareas que requieren atención inmediata ya están marcadas como **primordiales**, sin que él tenga que revisar nada. La decisión la toma el back-end combinando reglas deterministas (rápidas y auditables) con una capa de IA contextual (más lenta, pero más precisa). El usuario nunca aprueba la marca: la marca ya está hecha cuando abre la app.

### Principios de diseño
- **Híbrido, no solo IA:** las reglas duras (vence en <24h) no dependen del modelo. La IA solo afina la zona gris (1–7 días) y re-rankea.
- **Sin permiso, pero reversible:** la acción es no destructiva (solo un flag) y siempre se puede deshacer. No se pide aprobación, pero existe un "No es primordial" que aprende.
- **Explicable:** cada tarea primordial lleva una razón humana ("Vence en 5h y aún no la empiezas").
- **Acotado:** máximo 5 primordiales visibles a la vez. Si hay más, se ordenan por score.
- **Pre-computado, no on-request:** el score se calcula en background y en mutaciones de tarea. Al abrir la app solo se lee. Nunca se llama a la IA al abrir la pantalla.

### 6.5A: Motor de reglas (determinista, sin IA — disponible desde ya)

**Back-end:**
- Campos nuevos en `Task`: `aiPriority`, `effectivePriority`, `priorityScore`, `priorityReason`, `priorityComputedAt`, `priorityDismissedUntil`
- Pipeline de prioridad con dos capas:
  - **Regla dura (forzada):** vence en ≤ 4h y no completada → `CRITICAL` (primordial forzada)
  - **Regla alta:** vence en ≤ 24h y no completada → `HIGH` (primordial por defecto)
  - **Zona gris:** vence en ≤ 72h → `MEDIUM` (la IA puede subir o bajar)
  - **Baja:** > 72h o sin fecha → `LOW` (la IA puede elevar si hay contexto)
- `effectivePriority = max(userPriority, rulePriority)` — el usuario nunca pierde su prioridad manual, solo se suma la automática
- Trigger de recálculo: al crear/editar tarea con fecha, al completar/reabrir, y job horario para el paso del tiempo
- `GET /tasks/primordial` devuelve la lista pre-computada (solo lectura, rápida)
- Sin push al front salvo multi-dispositivo (coherente con el contrato de sync)

**Front-end:**
- Sección **"Primordiales"** en la parte superior de la lista de tareas y en la pantalla de inicio
- Chip de razón junto a cada tarea ("Vence en 5h", "Vence hoy", "Alta prioridad + vence mañana")
- Acción "No es primordial" que setea `priorityDismissedUntil` (24h por defecto) y alimenta la capa IA
- Sin llamadas extra al back: la lista ya viene servida

### 6.5B: Capa de IA contextual (requiere infra de Fase 10)

**Back-end:**
- Batch de IA: **máximo 1 llamada por usuario por hora**, agrupando todas las tareas en zona gris
- Input del modelo: tareas en zona gris + historial de cumplimiento del usuario + horas típicas de trabajo + sesiones programadas
- Output del modelo: `priorityScore` ajustado + `reason` humana por cada tarea que cambie de tier
- Restricciones duras del prompt:
  - El modelo **no puede** crear, borrar, mover fechas ni tocar el `userPriority`
  - El modelo **no puede** marcar primordial una tarea con `priorityDismissedUntil` vigente
  - El modelo **debe** devolver una razón de una línea por tarea cambiada
  - Sin fecha límite, el modelo puede elevar a `HIGH` como máximo — **nunca a `CRITICAL`** (evita urgencias inventadas)
- Aprendizaje: si el usuario descarta 3 veces la misma tarea como primordial, el modelo deja de elevarla (feedback loop)
- Si la IA falla o tarda: se usa solo el motor de reglas (degradación elegante)

**Front-end:**
- Nada nuevo: la UI de 6.5A ya muestra los resultados; la IA solo cambia el contenido de la lista
- El chat de Fase 10 puede explicar cualquier decisión: "¿Por qué X es primordial?" → responde con `priorityReason` + contexto histórico

### Seguridad y confianza
- **Nunca destructivo:** la IA solo pone flags; no edita tareas
- **Nunca silencioso en la razón:** si no hay razón, no hay marca
- **Nunca sin salida:** cada marca primordial tiene "No es primordial" accesible
- **Nunca saturado:** cap de 5 primordiales visibles; el resto queda ordenado por score
- **Siempre degradable:** sin IA, el motor de reglas funciona igual

### Decisiones de configuración (no hardcodear)
- Umbrales de las reglas (4h / 24h / 72h) en config, ajustables con datos reales
- Cap de primordiales visibles (5 por defecto)
- Ventana del "No es primordial" (24h por defecto)
- Peso del feedback loop (3 descartes → dejar de elevar)

### Comportamiento offline
- El front lee la última lista cacheada de `/tasks/primordial`
- El front puede aplicar la regla dura localmente (`dueAt` cacheado + offset de servidor)
- Al reconectar, reconciliación normal de Fase 4

---

## FASE 7: Mini Buscador
**Back-end:**
- Proxy de búsqueda (evita CORS, centraliza lógica)
- Endpoints por proveedor: `/search?engine=google|wikipedia|stackoverflow`
- Historial de búsquedas por usuario

**Front-end:**
- Ventana emergente o iframe con resultado servido por back
- UI del historial (leído del back)

---

## FASE 8: Estadísticas y Analytics
**Back-end:**
- Cálculo de sesiones completadas hoy, tiempo total, tareas completadas y rachas
- Análisis de productividad por día/hora (agregaciones en servidor)
- Endpoint de exportación JSON/CSV
- Los agregados se calculan **al abrir el dashboard** (`GET /stats`), no se empujan
- Métrica adicional: tasa de cumplimiento de tareas primordiales (cuántas se completaron antes del deadline vs. cuántas se ignoraron) — alimenta el feedback loop de 6.5B

**Front-end:**
- Dashboard que consume agregados del back bajo demanda
- Caché local de la última respuesta de `/stats`
- Gráficos simples de progreso
- Botones de exportación

---

## FASE 9: Pulimiento y UX
**Back-end:** (mínimo)
- Endpoint de preferencias de tema (para sync de dark mode entre dispositivos, opcional)

**Front-end:**
- Diseño visual y animaciones suaves
- Responsive design (móvil/tablet)
- Modo oscuro/claro
- Atajos de teclado
- Confirmaciones antes de resetear
- Mejoras de accesibilidad

---

## FASE 10: Integración de IA
**Back-end:**
- API key de Anthropic **solo en servidor** (nunca en front)
- Rate limiting por usuario
- Persistencia de historial de conversaciones
- Endpoints: `/ai/chat`, `/ai/history`
- La misma infra de IA (API key, rate limiting, batch) sirve a la capa contextual de priorización (6.5B), no solo al chat
- El chat debe poder explicar cualquier decisión de priorización usando `priorityReason` + historial del usuario

**Front-end:**
- UI de chat no intrusiva
- Render del historial
- Sin lógica de IA en cliente

---

## FASE 11: PWA
**Back-end:**
- Endpoint de push notifications (VAPID keys)
- `/sync` ya preparado para offline
- Push **solo** para notificaciones de fin de fase (es su única razón)

**Front-end:**
- `manifest.json`
- Service Worker con estrategia de caché
- Notificaciones locales programadas al iniciar cada fase (funciona sin red)
- El push del back es **respaldo**, no la vía principal
- Instalable en dispositivos móviles
- Iconos por tamaño de pantalla
- Reconciliación de datos al recuperar conexión

---

## FASE 12: App Nativa (React Native)
**Back-end:** (sin cambios — la API es la misma)

**Front-end:**
- Setup de React Native
- Migrar componentes principales
- Notificaciones nativas locales (misma política de respaldo)
- Almacenamiento nativo como capa de caché (misma sync engine)
- Permisos de audio
- Optimizaciones de rendimiento
- Testing en dispositivos reales
- Preparación para App Stores

---

## FASE 13: Publicación y Distribución
- Google Play Store
- Apple App Store
- Landing page del proyecto
- Documentación completa (API + arquitectura)
- Video demo
- Deployment en múltiples plataformas

---

## FUNCIONES EXTRA (durante cualquier fase)
- Diferentes tipos de música/sonidos (back sirve assets)
- Temas personalizables (preferencia sync opcional)
- Integración con Google Calendar *(aquí sí hace falta OAuth del calendario, pero es independiente del auth de la app)*
- Backup y restauración (endpoints `/export` y `/import`)
- Compartir estadísticas (link público generado por back)
- Modo focus extremo (bloquear distracciones — front, con feedback al back)

---

## Tabla rápida: ¿Round-trip al back o no?

**NO llamar al back para:**
- Cada transición de fase
- Cada tick del reloj
- Cambios de volumen momentáneos (mute, slider)
- Render de UI puro
- Cálculo de ciclo actual (ya está en el plan)

**SÍ llamar al back para:**
- Inicio de sesión (una vez)
- Pausa / resume / skip / reset (rompen el plan)
- Fin de sesión (una vez)
- CRUD de tareas
- Abrir vista de tareas / pantalla de inicio (pull de primordiales)
- Descartar primordial ("No es primordial")
- Cambio de preferencias que invalida el plan
- Flush de cola en `visibilitychange` o cada 1h

---

## Orden Recomendado por Prioridad

### ESENCIALES (app funcional básica):
**Fase 0 + Fases 1-2-3 + Fase 4** (versión mínima: caché + sync básico)
→ *Fase 0 es requisito previo a todo.*

### ÚTILES (app completa):
**Fases 5-6-6.5A-7-8-9**
→ *6.5A (reglas) entra aquí porque no depende de IA.*

### AVANZADAS (portfolio):
**Fases 6.5B-10-11-12-13**
→ *6.5B necesita la infra de Fase 10.*

---

## Costo real de la decisión (sync por eventos vs. sync por fase)

| Dimensión | Sync por fase | Sync por eventos |
|---|---|---|
| Requests por sesión de 4 ciclos | ~16 | ~3–5 |
| Latencia percibida | Depende de red en cada transición | Instantánea (local) |
| Funciona offline | ❌ No | ✅ Sí (plan local) |
| Escalabilidad | 1 request por usuario por fase | 1 request por usuario por sesión |
| Complejidad del front | Baja | Media (cola de eventos + reconciliación) |
| Complejidad del back | Baja | Media (idempotencia + versionado) |

El trade-off es **complejidad de sync** a cambio de **latencia, offline y escalabilidad**. Es el trade-off correcto para una app de concentración.

---

## Nota importante
- Empieza por **Fase 0** y ve paso a paso
- La auth por `deviceId` es suficiente para empezar; la interfaz `AuthProvider` deja la puerta abierta a email/OAuth sin reescribir nada
- No te abrumes con toda la ambición
- Es mejor una web app perfecta que tres apps a medias
- El nombre perfecto saldrá mientras programas 

---

## Tu trayectoria completa
**Back-end base → Web App → PWA → React Native → Portfolio de Software Engineer**