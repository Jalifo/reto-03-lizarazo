# Reto 03 — Agente conversacional "Órdenes de Compra SAP"

Agente que lee el paquete de una solicitud de compra, lo valida contra los maestros con las reglas RC1–RC10, construye la OC, genera la evidencia de aprobación y crea la orden en un SAP simulado. Pide confirmación humana cuando hay excepciones.

**Link de prueba:** `https://reto-03-lizarazo.onrender.com/`

## Requisitos

- Node.js 20.12 o superior (o Bun)
- Una clave de API del proveedor del modelo (solo para el chat; `demo.ts` no la necesita)

## Levantar en local (un comando)

```bash
npm install
cp .env.example .env      # en Windows PowerShell: Copy-Item .env.example .env
# edite .env y ponga ANTHROPIC_API_KEY
npm run dev
```

Abra http://localhost:3000. El mismo proceso sirve el front (`web/`) y la API.

Con Bun: `bun install && bun run src/server.ts`.

## Variables de entorno

| Variable | Obligatoria | Por defecto | Uso |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Para el chat | — | Clave del modelo. Solo en el backend. |
| `LLM_PROVEEDOR` | No | `anthropic` | Implementación del adaptador LLM. |
| `LLM_MODELO` | No | `claude-sonnet-5-5` | Modelo a usar. |
| `MAX_ITERACIONES` | No | `25` | Tope de iteraciones herramienta → modelo por turno. |
| `MAX_TOKENS_SESION` | No | `300000` | Tope de tokens por sesión (control de costo). |
| `LLM_TIMEOUT_MS` | No | `60000` | Timeout de cada llamada al modelo. |
| `APP_ACCESS_KEY` | No | — | Si se define, el link pide esta clave. |
| `PORT` | No | `3000` | Puerto HTTP. |

## Verificación sin modelo

```bash
npm run demo           # los 6 casos, idempotencia de sol-001 y confirmación de sol-004 (sin clave)
npm run prueba:ciclo   # ciclo del agente con un modelo guionizado: confirmación humana e idempotencia
npm run typecheck      # TypeScript estricto
npm run modulo -- --verificar   # el módulo bonus está sincronizado con la aplicación
```

`demo.ts` limpia `out/` al inicio, así que cada ejecución da el mismo resultado (salvo los timestamps).

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, tokens }` |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión (mensajes y llamadas a herramientas) |
| `GET` | `/api/health` | `{ ok, provider, model, accessKeyRequired }`, sin exponer claves |

Si `APP_ACCESS_KEY` está definida, `/api/chat` y `/api/sessions` exigen el encabezado `x-access-key`.

## Archivos que genera (`out/`)

| Archivo | Contenido |
|---|---|
| `out/sap/ordenes.jsonl` | OC creadas en el SAP simulado (número desde 4500000001) |
| `out/control.csv` | Un registro por intento de creación: exitoso, existente, bloqueado o pendiente, con la marca `retroactiva` |
| `out/log.jsonl` | Cada llamada a herramienta y cada error del modelo |
| `out/<caso>/payload.json` | La OC tal como quedaría en SAP |
| `out/<caso>/trazabilidad.json` | La fuente de cada valor del payload |
| `out/<caso>/aprobacion.txt` / `.pdf` | Evidencia de aprobación con su `sha256` |

## Estructura

```
agent/prompt.md                 comportamiento (system prompt)
src/knowledge/ordenes-compra.md conocimiento del proceso
src/tools/oc.ts                 herramientas oc_* (contrato del PRD 6.2)
src/oc/                         dominio: lectura, reglas RC1–RC10, payload, evidencia, registros
src/sap/adapter.ts, mock.ts     interfaz SapAdapter y SAP simulado sobre archivos
src/llm/adapter.ts, anthropic.ts interfaz del proveedor LLM e implementación
src/agent/                      ciclo del agente, registro de herramientas, configuración
src/server.ts                   API HTTP y archivos estáticos
web/                            front del chat
demo.ts                         verificación sin modelo
modulo/                         bonus: agente empaquetado (generado con npm run modulo)
```

## Despliegue (Render)

1. Suba el repositorio a GitHub.
2. En render.com: **New → Web Service** → conecte el repositorio.
3. Build command: `npm install` · Start command: `npm start`.
4. En **Environment**, agregue `ANTHROPIC_API_KEY` y, opcionalmente, `APP_ACCESS_KEY`.
5. Al terminar, Render entrega la URL pública.

En el plan gratuito el servicio se suspende tras un tiempo sin uso: la primera petición tarda unos segundos en despertarlo. Abra el link unos minutos antes de la defensa.
