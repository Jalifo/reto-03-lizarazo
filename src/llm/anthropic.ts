// Implementación de AdaptadorLlm para la API de Anthropic (Messages API) usando fetch nativo.
// La clave solo se lee de la variable de entorno y nunca se registra ni se devuelve.
import { ErrorLlm, type AdaptadorLlm, type BloqueLlamada, type HerramientaLlm, type MensajeLlm, type RespuestaLlm } from "./adapter"

type BloqueApi =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean }

type RespuestaApi = {
  content: BloqueApi[]
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string }
}

export class AdaptadorAnthropic implements AdaptadorLlm {
  readonly proveedor = "anthropic"

  constructor(
    private readonly clave: string,
    readonly modelo: string,
    private readonly timeoutMs: number,
    private readonly maxTokensRespuesta = 2048,
  ) {}

  async enviar(mensajes: MensajeLlm[], herramientas: HerramientaLlm[]): Promise<RespuestaLlm> {
    const sistema = mensajes.flatMap((m) => (m.rol === "system" ? [m.contenido] : [])).join("\n\n")
    const conversacion = mensajes.flatMap((m) => (m.rol === "system" ? [] : [aApi(m)]))
    const control = new AbortController()
    const temporizador = setTimeout(() => control.abort(), this.timeoutMs)
    try {
      const respuesta = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: control.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.clave,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.modelo,
          max_tokens: this.maxTokensRespuesta,
          system: sistema,
          messages: conversacion,
          tools: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, input_schema: h.esquema })),
        }),
      })
      const cuerpo = (await respuesta.json()) as RespuestaApi
      if (!respuesta.ok) {
        throw new ErrorLlm(`El proveedor respondió ${respuesta.status}: ${cuerpo.error?.message ?? "error desconocido"}`)
      }
      const llamadas: BloqueLlamada[] = []
      const textos: string[] = []
      for (const b of cuerpo.content) {
        if (b.type === "text") textos.push(b.text)
        if (b.type === "tool_use") llamadas.push({ tipo: "llamada", id: b.id, nombre: b.name, argumentos: b.input })
      }
      return {
        texto: textos.join("\n").trim(),
        llamadas,
        uso: { entrada: cuerpo.usage?.input_tokens ?? 0, salida: cuerpo.usage?.output_tokens ?? 0 },
      }
    } catch (e) {
      if (e instanceof ErrorLlm) throw e
      if (e instanceof Error && e.name === "AbortError") {
        throw new ErrorLlm(`El modelo no respondió en ${Math.round(this.timeoutMs / 1000)} segundos.`)
      }
      throw new ErrorLlm(`No se pudo contactar al proveedor del modelo: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      clearTimeout(temporizador)
    }
  }
}

function aApi(m: Exclude<MensajeLlm, { rol: "system" }>): { role: "user" | "assistant"; content: BloqueApi[] } {
  const content: BloqueApi[] = m.contenido.map((b): BloqueApi => {
    if (b.tipo === "texto") return { type: "text", text: b.texto }
    if (b.tipo === "llamada") return { type: "tool_use", id: b.id, name: b.nombre, input: b.argumentos }
    return { type: "tool_result", tool_use_id: b.idLlamada, content: b.contenido, is_error: b.esError }
  })
  return { role: m.rol, content }
}
