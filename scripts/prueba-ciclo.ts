// Prueba del ciclo del agente SIN clave: un "modelo guionizado" que llama herramientas como lo haría
// un LLM, incluido un intento de saltarse la confirmación humana. Verifica CA1, CA3 y la idempotencia.
// Ejecutar: npm run prueba:ciclo
import { rm } from "node:fs/promises"
import path from "node:path"
import type { AdaptadorLlm, BloqueLlamada, MensajeLlm, RespuestaLlm } from "../src/llm/adapter"
import { procesarMensaje, type RespuestaTurno } from "../src/agent/ciclo"

let contador = 0
const llamar = (nombre: string, argumentos: Record<string, unknown>): BloqueLlamada => ({
  tipo: "llamada",
  id: `t${++contador}`,
  nombre,
  argumentos,
})

/** Busca en la conversación el último payload devuelto por oc_construir_payload. */
function ultimoPayload(mensajes: MensajeLlm[]): unknown {
  for (const m of [...mensajes].reverse()) {
    if (m.rol !== "user") continue
    for (const b of m.contenido) {
      if (b.tipo !== "resultado") continue
      const r = JSON.parse(b.contenido) as { ok: boolean; data?: { orden?: unknown } }
      if (r.ok && r.data?.orden) return r.data.orden
    }
  }
  return undefined
}

class ModeloGuionizado implements AdaptadorLlm {
  readonly proveedor = "guion"
  readonly modelo = "prueba"
  async enviar(mensajes: MensajeLlm[]): Promise<RespuestaLlm> {
    const uso = { entrada: 100, salida: 20 }
    const ultimo = mensajes[mensajes.length - 1]
    const ultimoUsuario = [...mensajes].reverse().find((m) => m.rol === "user" && m.contenido.some((b) => b.tipo === "texto"))
    const pedido = ultimoUsuario && ultimoUsuario.rol === "user" ? ultimoUsuario.contenido.map((b) => (b.tipo === "texto" ? b.texto : "")).join("") : ""
    const caso = pedido.match(/sol-\d{3}/)?.[0] ?? "sol-004"
    const esperandoResultados = ultimo?.rol === "user" && ultimo.contenido.some((b) => b.tipo === "resultado")

    if (/confirmo/i.test(pedido)) {
      if (!esperandoResultados) return { texto: "", llamadas: [llamar("oc_crear", { caso: "sol-004", payload: ultimoPayload(mensajes), confirmado: true })], uso }
      return { texto: "Listo, OC creada.", llamadas: [], uso }
    }
    if (!esperandoResultados) {
      return { texto: "", llamadas: [llamar("oc_leer_paquete", { caso }), llamar("oc_validar", { caso }), llamar("oc_construir_payload", { caso }), llamar("oc_generar_evidencia", { caso })], uso }
    }
    // Segunda iteración: el "modelo" intenta crear con confirmado = true sin preguntar (debe impedirse).
    const resultados = ultimo?.rol === "user" ? ultimo.contenido.map((b) => (b.tipo === "resultado" ? b.contenido : "")).join("") : ""
    if (!resultados.includes("requiere_confirmacion")) {
      return { texto: "", llamadas: [llamar("oc_crear", { caso, payload: ultimoPayload(mensajes), confirmado: true })], uso }
    }
    return { texto: `¿Confirmas la creación de la OC de ${caso} con estas excepciones?`, llamadas: [], uso }
  }
}

function verificar(condicion: boolean, descripcion: string): void {
  console.log(`${condicion ? "✔" : "✖"} ${descripcion}`)
  if (!condicion) process.exitCode = 1
}

async function main(): Promise<void> {
  const directorio = process.cwd()
  await rm(path.join(directorio, "out"), { recursive: true, force: true })
  const op = { adaptador: new ModeloGuionizado(), promptSistema: "prueba", directorio, maxIteraciones: 25, maxTokensSesion: 100000 }

  const t1: RespuestaTurno = await procesarMensaje(undefined, "Procesa la solicitud sol-004", op)
  const intento = t1.toolCalls.find((l) => l.nombre === "oc_crear")
  verificar(intento?.argumentos.confirmado === false, "CA3: el backend anula confirmado=true cuando el usuario aún no ha confirmado")
  verificar(intento?.ok === false, "CA3: la OC de sol-004 NO se crea en el mismo turno")
  verificar(t1.needsConfirmation, "El turno termina con needsConfirmation = true (el front lo resalta)")

  const t2 = await procesarMensaje(t1.sessionId, "Confirmo", op)
  const creada = t2.toolCalls.find((l) => l.nombre === "oc_crear")
  verificar(creada?.ok === true && creada.resumen.includes("4500000001"), `Tras "Confirmo" se crea la OC: ${creada?.resumen}`)
  verificar(!t2.needsConfirmation, "Después de crear, ya no hay confirmación pendiente")

  const t3 = await procesarMensaje(t2.sessionId, "Confirmo", op)
  const repetida = t3.toolCalls.find((l) => l.nombre === "oc_crear")
  verificar(repetida?.resumen.includes("ya existía") === true, "Idempotencia: confirmar otra vez devuelve la misma OC")

  const sinClave = await procesarMensaje(undefined, "hola", { ...op, adaptador: null })
  verificar(sinClave.reply.includes("ANTHROPIC_API_KEY"), "CA5: sin clave, el chat explica el problema y no se cae")
}

main().catch((e: unknown) => {
  console.error(e)
  process.exitCode = 1
})
