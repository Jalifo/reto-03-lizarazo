// Ciclo del agente (PRD 6.3): prompt → modelo → herramientas → modelo … → respuesta.
// CA1 tope de iteraciones · CA2 valores solo desde herramientas · CA3 confirmación humana aplicada en código
// CA4 toda llamada visible y en out/log.jsonl · CA5 los errores se muestran y la sesión sigue viva.
import { randomUUID } from "node:crypto"
import type { AdaptadorLlm, BloqueLlamada, BloqueResultado, BloqueTexto, MensajeLlm } from "../llm/adapter"
import { ejecutarHerramienta, herramientasParaLlm } from "./herramientas"
import { registrarLog } from "../oc/registro"

export type LlamadaVisible = {
  nombre: string
  argumentos: Record<string, unknown>
  ok: boolean
  resumen: string
  resultado: string
  ms: number
}

export type EventoVisible =
  | { tipo: "usuario"; texto: string; ts: string }
  | { tipo: "agente"; texto: string; ts: string; necesitaConfirmacion: boolean }
  | { tipo: "herramienta"; llamada: LlamadaVisible; ts: string }
  | { tipo: "error"; texto: string; ts: string }

type Pendiente = { caso: string; desdeTurno: number; ultimoTurno: number }

export type Sesion = {
  id: string
  creada: string
  turno: number
  mensajes: MensajeLlm[]
  eventos: EventoVisible[]
  tokens: { entrada: number; salida: number }
  pendiente: Pendiente | null
}

export type RespuestaTurno = {
  sessionId: string
  reply: string
  toolCalls: LlamadaVisible[]
  needsConfirmation: boolean
  tokens: { entrada: number; salida: number }
}

export type OpcionesCiclo = {
  adaptador: AdaptadorLlm | null
  promptSistema: string
  directorio: string
  maxIteraciones: number
  maxTokensSesion: number
}

const MAX_SESIONES = 200
const MAX_RESULTADO_MODELO = 8000
const sesiones = new Map<string, Sesion>()

export function obtenerSesion(id: string): Sesion | undefined {
  return sesiones.get(id)
}

function crearSesion(): Sesion {
  if (sesiones.size >= MAX_SESIONES) {
    const masAntigua = sesiones.keys().next().value
    if (masAntigua !== undefined) sesiones.delete(masAntigua)
  }
  const s: Sesion = {
    id: randomUUID(),
    creada: new Date().toISOString(),
    turno: 0,
    mensajes: [],
    eventos: [],
    tokens: { entrada: 0, salida: 0 },
    pendiente: null,
  }
  sesiones.set(s.id, s)
  return s
}

const AFIRMATIVA = /(^|[^\p{L}])(confirmo|confirmado|confirmada|s[ií]|dale|procede|procedé|adelante|apruebo|cr[eé]ala|de acuerdo|ok)(?![\p{L}])/iu
const NEGATIVA = /(^|[^\p{L}])no\s+(confirmo|la\s+cre|lo\s+cre|proced|quiero|apruebo)/iu

/** CA3: el usuario confirma solo con un mensaje afirmativo y sin negación explícita. */
export function esConfirmacion(texto: string): boolean {
  return AFIRMATIVA.test(texto) && !NEGATIVA.test(texto)
}

function resumir(nombre: string, resultado: string): { ok: boolean; resumen: string } {
  try {
    const r = JSON.parse(resultado) as { ok: boolean; error?: string; data?: Record<string, unknown> }
    if (!r.ok) return { ok: false, resumen: r.error ?? "error" }
    const d = r.data ?? {}
    if (nombre === "oc_validar") {
      const n = (k: string) => (Array.isArray(d[k]) ? (d[k] as unknown[]).length : 0)
      return { ok: true, resumen: `apta=${String(d.apta)} · bloqueos=${n("bloqueos")} · confirmaciones=${n("confirmaciones")} · retroactiva=${String(d.retroactiva)}` }
    }
    if (nombre === "oc_crear") return { ok: true, resumen: `OC ${String(d.numero_oc)}${d.idempotente ? " (ya existía)" : ""}` }
    if (nombre === "oc_generar_evidencia") return { ok: true, resumen: `sha256 ${String(d.sha256).slice(0, 12)}…` }
    if (nombre === "oc_construir_payload") return { ok: true, resumen: `payload listo · ${String(d.trazabilidad)}` }
    return { ok: true, resumen: "ok" }
  } catch {
    return { ok: false, resumen: "respuesta no legible" }
  }
}

/** Actualiza el estado de confirmación pendiente según lo que devolvieron las herramientas. */
function actualizarPendiente(sesion: Sesion, nombre: string, caso: string, resultado: string): void {
  const r = JSON.parse(resultado) as { ok: boolean; requiere_confirmacion?: boolean; data?: { apta?: boolean; confirmaciones?: unknown[] } }
  const pide =
    (nombre === "oc_validar" && r.ok && r.data?.apta === true && (r.data.confirmaciones?.length ?? 0) > 0) ||
    (nombre === "oc_crear" && !r.ok && r.requiere_confirmacion === true)
  if (pide) {
    if (sesion.pendiente?.caso === caso) sesion.pendiente.ultimoTurno = sesion.turno
    else sesion.pendiente = { caso, desdeTurno: sesion.turno, ultimoTurno: sesion.turno }
  }
  if (nombre === "oc_crear" && r.ok && sesion.pendiente?.caso === caso) sesion.pendiente = null
}

/**
 * CA3 aplicado en el backend: `confirmado = true` solo vale si la confirmación se pidió en un turno
 * ANTERIOR para ese mismo caso y el mensaje actual del usuario es afirmativo. Si no, se ignora
 * (se envía como false) y la herramienta responde que requiere confirmación.
 */
function autorizarConfirmacion(sesion: Sesion, args: Record<string, unknown>, mensajeUsuario: string): Record<string, unknown> {
  if (args.confirmado !== true) return args
  const p = sesion.pendiente
  const valida = p !== null && p.caso === args.caso && p.desdeTurno < sesion.turno && esConfirmacion(mensajeUsuario)
  return valida ? args : { ...args, confirmado: false }
}

function texto(t: string): BloqueTexto {
  return { tipo: "texto", texto: t }
}

export async function procesarMensaje(sessionId: string | undefined, mensaje: string, op: OpcionesCiclo): Promise<RespuestaTurno> {
  const sesion = (sessionId && sesiones.get(sessionId)) || crearSesion()
  sesion.turno += 1
  const ahora = () => new Date().toISOString()
  sesion.eventos.push({ tipo: "usuario", texto: mensaje, ts: ahora() })
  sesion.mensajes.push({ rol: "user", contenido: [texto(mensaje)] })

  const llamadasTurno: LlamadaVisible[] = []
  const responder = (reply: string, esError = false): RespuestaTurno => {
    const necesita = sesion.pendiente !== null && sesion.pendiente.ultimoTurno === sesion.turno
    sesion.eventos.push(esError ? { tipo: "error", texto: reply, ts: ahora() } : { tipo: "agente", texto: reply, ts: ahora(), necesitaConfirmacion: necesita })
    // Mantiene la conversación válida para el siguiente turno aunque haya habido error.
    if (esError) sesion.mensajes.push({ rol: "assistant", contenido: [texto(reply)] })
    return { sessionId: sesion.id, reply, toolCalls: llamadasTurno, needsConfirmation: necesita, tokens: { ...sesion.tokens } }
  }

  if (!op.adaptador) {
    return responder("El servidor no tiene configurada la clave del modelo (ANTHROPIC_API_KEY). Las herramientas funcionan con `npm run demo`, pero el chat necesita la clave.", true)
  }

  const herramientas = herramientasParaLlm()
  for (let iteracion = 1; iteracion <= op.maxIteraciones; iteracion++) {
    if (sesion.tokens.entrada + sesion.tokens.salida >= op.maxTokensSesion) {
      return responder(`Se alcanzó el tope de ${op.maxTokensSesion} tokens de esta sesión. Abre una sesión nueva para continuar.`, true)
    }

    let respuesta
    try {
      respuesta = await op.adaptador.enviar([{ rol: "system", contenido: op.promptSistema }, ...sesion.mensajes], herramientas)
    } catch (e) {
      const motivo = e instanceof Error ? e.message : String(e)
      await registrarLog(op.directorio, { sessionId: sesion.id, turno: sesion.turno, evento: "error_llm", motivo })
      return responder(`No pude completar la respuesta: ${motivo} Puedes intentarlo de nuevo; la sesión sigue activa.`, true)
    }
    sesion.tokens.entrada += respuesta.uso.entrada
    sesion.tokens.salida += respuesta.uso.salida

    const contenidoAsistente: Array<BloqueTexto | BloqueLlamada> = []
    if (respuesta.texto) contenidoAsistente.push(texto(respuesta.texto))
    contenidoAsistente.push(...respuesta.llamadas)
    sesion.mensajes.push({ rol: "assistant", contenido: contenidoAsistente.length ? contenidoAsistente : [texto("…")] })

    if (respuesta.llamadas.length === 0) return responder(respuesta.texto || "(sin respuesta)")

    const resultados: BloqueResultado[] = []
    for (const llamada of respuesta.llamadas) {
      const args = autorizarConfirmacion(sesion, llamada.argumentos, mensaje)
      const inicio = Date.now()
      const resultado = await ejecutarHerramienta(llamada.nombre, args, { directory: op.directorio, sessionId: sesion.id })
      const ms = Date.now() - inicio
      const { ok, resumen } = resumir(llamada.nombre, resultado)
      const caso = typeof args.caso === "string" ? args.caso : ""
      actualizarPendiente(sesion, llamada.nombre, caso, resultado)

      const visible: LlamadaVisible = { nombre: llamada.nombre, argumentos: args, ok, resumen, resultado: resultado.slice(0, 4000), ms }
      llamadasTurno.push(visible)
      sesion.eventos.push({ tipo: "herramienta", llamada: visible, ts: ahora() })
      await registrarLog(op.directorio, { sessionId: sesion.id, turno: sesion.turno, herramienta: llamada.nombre, caso, ok, resumen, ms })
      resultados.push({ tipo: "resultado", idLlamada: llamada.id, contenido: resultado.slice(0, MAX_RESULTADO_MODELO), esError: !ok })
    }
    sesion.mensajes.push({ rol: "user", contenido: resultados })
  }

  // CA1: tope alcanzado. Se responde con lo que hay y lo que falta.
  const hechas = llamadasTurno.map((l) => `${l.nombre} → ${l.resumen}`).join("\n- ")
  const aviso = `Alcancé el tope de ${op.maxIteraciones} iteraciones en este turno.\n\nLo que alcancé a hacer:\n- ${hechas || "nada"}\n\nPídeme que continúe para terminar.`
  sesion.mensajes.push({ rol: "assistant", contenido: [texto(aviso)] })
  return responder(aviso)
}
