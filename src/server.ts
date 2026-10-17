// API HTTP del chat (PRD 6.4) + archivos estáticos del front (web/). Sin frameworks: node:http.
// Un solo comando levanta front y backend: npm run dev
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { CONFIG, cargarPromptSistema, crearAdaptador } from "./agent/config"
import { obtenerSesion, procesarMensaje } from "./agent/ciclo"

const adaptador = crearAdaptador()
const promptSistema = cargarPromptSistema(CONFIG.directorio)
const MAX_CUERPO = 32 * 1024
const MAX_MENSAJE = 4000

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
}

function enviarJson(res: ServerResponse, estado: number, cuerpo: unknown): void {
  res.writeHead(estado, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(cuerpo))
}

async function leerCuerpo(req: IncomingMessage): Promise<unknown> {
  let tamano = 0
  const partes: Buffer[] = []
  for await (const parte of req) {
    const b = parte as Buffer
    tamano += b.length
    if (tamano > MAX_CUERPO) throw new Error("Cuerpo demasiado grande")
    partes.push(b)
  }
  return JSON.parse(Buffer.concat(partes).toString("utf8") || "{}")
}

function autorizado(req: IncomingMessage): boolean {
  return CONFIG.claveAcceso === null || req.headers["x-access-key"] === CONFIG.claveAcceso
}

async function servirEstatico(res: ServerResponse, ruta: string): Promise<void> {
  const nombre = ruta === "/" ? "index.html" : ruta.slice(1)
  if (!/^[a-z0-9-]+\.(html|js|css)$/.test(nombre)) return enviarJson(res, 404, { ok: false, error: "No encontrado" })
  try {
    const contenido = await readFile(path.join(CONFIG.directorio, "web", nombre))
    res.writeHead(200, {
      "content-type": TIPOS[path.extname(nombre)] ?? "application/octet-stream",
      "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'",
      "x-content-type-options": "nosniff",
    })
    res.end(contenido)
  } catch {
    enviarJson(res, 404, { ok: false, error: "No encontrado" })
  }
}

async function manejar(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost")
  const ruta = url.pathname

  if (req.method === "GET" && ruta === "/api/health") {
    return enviarJson(res, 200, {
      ok: true,
      provider: adaptador?.proveedor ?? "sin configurar",
      model: adaptador?.modelo ?? null,
      accessKeyRequired: CONFIG.claveAcceso !== null,
    })
  }

  if (ruta.startsWith("/api/") && !autorizado(req)) {
    return enviarJson(res, 401, { ok: false, error: "Clave de acceso inválida" })
  }

  if (req.method === "POST" && ruta === "/api/chat") {
    let cuerpo: { sessionId?: unknown; message?: unknown }
    try {
      cuerpo = (await leerCuerpo(req)) as typeof cuerpo
    } catch {
      return enviarJson(res, 400, { ok: false, error: "Cuerpo JSON inválido" })
    }
    const mensaje = typeof cuerpo.message === "string" ? cuerpo.message.trim() : ""
    if (!mensaje || mensaje.length > MAX_MENSAJE) {
      return enviarJson(res, 400, { ok: false, error: `El mensaje debe tener entre 1 y ${MAX_MENSAJE} caracteres` })
    }
    const sessionId = typeof cuerpo.sessionId === "string" ? cuerpo.sessionId : undefined
    const respuesta = await procesarMensaje(sessionId, mensaje, {
      adaptador,
      promptSistema,
      directorio: CONFIG.directorio,
      maxIteraciones: CONFIG.maxIteraciones,
      maxTokensSesion: CONFIG.maxTokensSesion,
    })
    return enviarJson(res, 200, respuesta)
  }

  const sesion = ruta.match(/^\/api\/sessions\/([\w-]+)$/)
  if (req.method === "GET" && sesion?.[1]) {
    const s = obtenerSesion(sesion[1])
    if (!s) return enviarJson(res, 404, { ok: false, error: "Sesión no encontrada" })
    return enviarJson(res, 200, { id: s.id, creada: s.creada, turnos: s.turno, tokens: s.tokens, eventos: s.eventos })
  }

  if (req.method === "GET" && !ruta.startsWith("/api/")) return servirEstatico(res, ruta)
  enviarJson(res, 404, { ok: false, error: "Ruta no encontrada" })
}

createServer((req, res) => {
  manejar(req, res).catch((e: unknown) => {
    console.error("Error no controlado:", e instanceof Error ? e.message : e)
    if (!res.headersSent) enviarJson(res, 500, { ok: false, error: "Error interno del servidor" })
  })
}).listen(CONFIG.puerto, () => {
  console.log(`Chat en http://localhost:${CONFIG.puerto}`)
  console.log(`Modelo: ${adaptador ? `${adaptador.proveedor} / ${adaptador.modelo}` : "SIN CONFIGURAR (falta ANTHROPIC_API_KEY)"}`)
  if (CONFIG.claveAcceso) console.log("Acceso protegido con APP_ACCESS_KEY")
})
