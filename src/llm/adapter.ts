// Interfaz propia del proveedor de modelo (PRD 6.1). El ciclo del agente solo conoce estos tipos:
// cambiar de proveedor = escribir otra implementación de AdaptadorLlm, sin tocar el ciclo.

export type BloqueTexto = { tipo: "texto"; texto: string }
export type BloqueLlamada = { tipo: "llamada"; id: string; nombre: string; argumentos: Record<string, unknown> }
export type BloqueResultado = { tipo: "resultado"; idLlamada: string; contenido: string; esError: boolean }

export type MensajeLlm =
  | { rol: "system"; contenido: string }
  | { rol: "user"; contenido: Array<BloqueTexto | BloqueResultado> }
  | { rol: "assistant"; contenido: Array<BloqueTexto | BloqueLlamada> }

export type HerramientaLlm = { nombre: string; descripcion: string; esquema: Record<string, unknown> }

export type RespuestaLlm = {
  texto: string
  llamadas: BloqueLlamada[]
  uso: { entrada: number; salida: number }
}

export interface AdaptadorLlm {
  readonly proveedor: string
  readonly modelo: string
  enviar(mensajes: MensajeLlm[], herramientas: HerramientaLlm[]): Promise<RespuestaLlm>
}

export class ErrorLlm extends Error {}
