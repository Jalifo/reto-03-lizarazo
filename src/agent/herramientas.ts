// Registro de herramientas: publica cada export de src/tools/oc.ts como "oc_<export>",
// genera el JSON Schema desde zod y valida los argumentos antes de ejecutar (PRD 6.2).
import { z } from "zod/v4"
import * as oc from "../tools/oc"
import type { HerramientaLlm } from "../llm/adapter"
import type { ContextoHerramienta } from "../oc/tipos"

type DefinicionHerramienta = {
  description: string
  args: Record<string, z.ZodType>
  execute(args: Record<string, unknown>, ctx: ContextoHerramienta): Promise<string>
}

type HerramientaRegistrada = { definicion: DefinicionHerramienta; esquema: z.ZodObject; llm: HerramientaLlm }

function esDefinicion(valor: unknown): valor is DefinicionHerramienta {
  if (typeof valor !== "object" || valor === null) return false
  const v = valor as Record<string, unknown>
  return typeof v.description === "string" && typeof v.args === "object" && typeof v.execute === "function"
}

function registrar(archivo: string, modulo: Record<string, unknown>): Map<string, HerramientaRegistrada> {
  const registro = new Map<string, HerramientaRegistrada>()
  for (const [exportado, valor] of Object.entries(modulo)) {
    if (!esDefinicion(valor)) continue
    const nombre = `${archivo}_${exportado}`
    const esquema = z.object(valor.args)
    const { $schema: _omitido, ...json } = z.toJSONSchema(esquema) as Record<string, unknown>
    registro.set(nombre, { definicion: valor, esquema, llm: { nombre, descripcion: valor.description, esquema: json } })
  }
  return registro
}

export const HERRAMIENTAS = registrar("oc", oc)

export function herramientasParaLlm(): HerramientaLlm[] {
  return [...HERRAMIENTAS.values()].map((h) => h.llm)
}

/** Valida argumentos con zod y ejecuta. Nunca lanza: los errores vuelven al modelo como { ok: false }. */
export async function ejecutarHerramienta(nombre: string, argumentos: unknown, ctx: ContextoHerramienta): Promise<string> {
  const h = HERRAMIENTAS.get(nombre)
  if (!h) return JSON.stringify({ ok: false, error: `Herramienta desconocida: ${nombre}` })
  const parsed = h.esquema.safeParse(argumentos)
  if (!parsed.success) {
    const detalle = parsed.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
    return JSON.stringify({ ok: false, error: `Argumentos inválidos para ${nombre}: ${detalle}` })
  }
  return h.definicion.execute(parsed.data, ctx)
}
