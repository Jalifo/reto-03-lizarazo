// Herramientas del agente (PRD 6.2). Cada export se publica al modelo como oc_<export>.
// Contrato: { description, args (zod con .describe), execute(args, ctx) → string JSON }. Nunca lanzan.
//
// Principio de diseño: las herramientas SIEMPRE releen las fuentes por `caso`. Los datos que el modelo
// envía (paquete, derivados, payload) se usan solo para verificar que no fueron alterados.
import { z } from "zod/v4"
import { cargarMaestros, leerAprobacionArchivo, leerPaquete, rutaCaso } from "../oc/fuentes"
import { validarPaquete } from "../oc/reglas"
import { construirOrden, mismasOrdenes } from "../oc/payload"
import { escribirEvidencia } from "../oc/evidencia"
import { registrarControl } from "../oc/registro"
import { OrdenCompraSchema, type AprobacionArchivo, type ContextoHerramienta, type Maestros, type Paquete, type Validacion } from "../oc/tipos"
import type { SapAdapter } from "../sap/adapter"
import { SapMock } from "../sap/mock"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

// ---------- Infraestructura común ----------

let fabricaSap: (directorio: string) => SapAdapter = (d) => new SapMock(d)

/** Punto de extensión: en producción se inyecta el adaptador SAP real sin tocar las herramientas. */
export function configurarSap(fabrica: (directorio: string) => SapAdapter): void {
  fabricaSap = fabrica
}

function ok(data: unknown): string {
  return JSON.stringify({ ok: true, data })
}
function falla(error: string, detalle?: Record<string, unknown>): string {
  return JSON.stringify(detalle ? { ok: false, error, ...detalle } : { ok: false, error })
}

/** Garantiza que ninguna herramienta lance: cualquier excepción se convierte en { ok: false, error }. */
async function seguro(tarea: () => Promise<string>): Promise<string> {
  try {
    return await tarea()
  } catch (e) {
    return falla(`Error interno: ${e instanceof Error ? e.message : String(e)}`)
  }
}

type Preparado = { paquete: Paquete; maestros: Maestros; validacion: Validacion; aprobacion: AprobacionArchivo | null }

async function preparar(caso: string, ctx: ContextoHerramienta): Promise<{ error: string } | Preparado> {
  const paquete = await leerPaquete(ctx.directory, caso)
  if (!paquete.ok) return { error: paquete.error }
  const maestros = await cargarMaestros(ctx.directory)
  if (!maestros.ok) return { error: maestros.error }
  const dir = rutaCaso(ctx.directory, caso)
  const aprobacion = dir ? await leerAprobacionArchivo(dir) : null
  return { paquete: paquete.data, maestros: maestros.data, validacion: validarPaquete(paquete.data, maestros.data), aprobacion }
}

const argCaso = z.string().describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo sol-001")

// ---------- oc_leer_paquete (HU-1) ----------

export const leer_paquete = {
  description: "Lee el correo, la solicitud, la cotización, la aprobación y la factura (si existe) de un caso y los devuelve normalizados.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: ContextoHerramienta): Promise<string> {
    return seguro(async () => {
      const r = await leerPaquete(ctx.directory, args.caso)
      if (!r.ok) return falla(r.error)
      // El texto completo de la cotización no se devuelve al modelo: es dato no confiable y gasta tokens.
      const { cotizacion, ...resto } = r.data
      return ok({ ...resto, cotizacion: cotizacion ? { ...cotizacion, texto: `(${cotizacion.texto.length} caracteres)` } : null })
    })
  },
}

// ---------- oc_validar (HU-2) ----------

export const validar = {
  description: "Aplica las reglas de control RC1–RC10 a un caso y devuelve si es apto, sus bloqueos, confirmaciones, valores derivados y si es retroactivo.",
  args: {
    caso: argCaso,
    paquete: z
      .unknown()
      .optional()
      .describe("Paquete devuelto por oc_leer_paquete. Opcional: la validación siempre relee la fuente original del caso."),
  },
  async execute(args: { caso: string; paquete?: unknown }, ctx: ContextoHerramienta): Promise<string> {
    return seguro(async () => {
      const p = await preparar(args.caso, ctx)
      if ("error" in p) return falla(p.error)
      return ok(p.validacion)
    })
  },
}

// ---------- oc_construir_payload (HU-3) ----------

export const construir_payload = {
  description: "Construye la orden de compra exactamente como quedaría en SAP, validada con zod, y guarda la trazabilidad de cada valor.",
  args: {
    caso: argCaso,
    paquete: z.unknown().optional().describe("Paquete de oc_leer_paquete. Opcional: se relee la fuente original."),
    derivados: z.unknown().optional().describe("Derivados de oc_validar. Opcional: se recalculan desde los maestros."),
  },
  async execute(args: { caso: string; paquete?: unknown; derivados?: unknown }, ctx: ContextoHerramienta): Promise<string> {
    return seguro(async () => {
      const p = await preparar(args.caso, ctx)
      if ("error" in p) return falla(p.error)
      if (!p.aprobacion) return falla("No hay correo de aprobación; no se puede construir el payload.")
      const r = construirOrden(p.paquete, p.validacion, p.maestros, p.aprobacion)
      if ("error" in r) return falla(r.error, { bloqueos: p.validacion.bloqueos.map((b) => b.codigo) })
      const carpeta = path.join(ctx.directory, "out", args.caso)
      await mkdir(carpeta, { recursive: true })
      await writeFile(path.join(carpeta, "trazabilidad.json"), JSON.stringify(r.trazabilidad, null, 2), "utf8")
      await writeFile(path.join(carpeta, "payload.json"), JSON.stringify(r.orden, null, 2), "utf8")
      return ok({ orden: r.orden, trazabilidad: `out/${args.caso}/trazabilidad.json` })
    })
  },
}

// ---------- oc_generar_evidencia (HU-4) ----------

export const generar_evidencia = {
  description: "Genera la evidencia del correo de aprobación en out/<caso>/aprobacion.txt y aprobacion.pdf, con su hash sha256.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: ContextoHerramienta): Promise<string> {
    return seguro(async () => {
      const dir = rutaCaso(ctx.directory, args.caso)
      if (!dir) return falla(`Nombre de caso inválido: "${args.caso}".`)
      const aprobacion = await leerAprobacionArchivo(dir)
      if (!aprobacion) return falla("El caso no tiene un correo de aprobación legible.")
      return ok(await escribirEvidencia(ctx.directory, args.caso, aprobacion))
    })
  },
}

// ---------- oc_crear (HU-5) ----------

export const crear = {
  description:
    "Crea la OC en SAP (simulado). Solo procede si el caso es apto y no tiene confirmaciones pendientes, o si confirmado = true tras la confirmación explícita del usuario. Es idempotente.",
  args: {
    caso: argCaso,
    payload: OrdenCompraSchema.optional().describe(
      "Orden devuelta por oc_construir_payload, sin modificar. Se verifica contra las fuentes. Puede omitirse si el caso tiene bloqueos (solo registra el intento).",
    ),
    confirmado: z
      .boolean()
      .optional()
      .describe("true solo si el usuario confirmó explícitamente las excepciones en su último mensaje."),
  },
  async execute(
    args: { caso: string; payload?: z.infer<typeof OrdenCompraSchema>; confirmado?: boolean },
    ctx: ContextoHerramienta,
  ): Promise<string> {
    return seguro(async () => {
      const p = await preparar(args.caso, ctx)
      if ("error" in p) return falla(p.error)
      const { paquete, validacion } = p
      const fila = {
        solicitud_id: paquete.solicitud.solicitud_id,
        retroactiva: validacion.retroactiva,
        bloqueos: validacion.bloqueos.map((b) => b.codigo),
        confirmaciones: validacion.confirmaciones.map((c) => c.codigo),
      }

      // 1. Bloqueos: nunca se crea.
      if (!validacion.apta) {
        await registrarControl(ctx.directory, { ...fila, resultado: "bloqueado", numero_oc: "" })
        return falla("La OC no se crea: la solicitud tiene bloqueos.", { bloqueos: validacion.bloqueos })
      }

      // 2. Idempotencia: si ya existe una OC para esta solicitud, se devuelve la misma.
      const sap = fabricaSap(ctx.directory)
      const existente = await sap.buscarOrdenPorReferencia(paquete.solicitud.solicitud_id)
      if (existente) {
        await registrarControl(ctx.directory, { ...fila, resultado: "existente", numero_oc: existente.numero_oc })
        return ok({ numero_oc: existente.numero_oc, fecha: null, idempotente: true, retroactiva: validacion.retroactiva })
      }

      // 3. Confirmación humana: excepciones pendientes sin confirmado = true.
      if (validacion.confirmaciones.length > 0 && args.confirmado !== true) {
        await registrarControl(ctx.directory, { ...fila, resultado: "pendiente", numero_oc: "" })
        return falla("La OC requiere confirmación humana antes de crearse.", {
          requiere_confirmacion: true,
          confirmaciones: validacion.confirmaciones,
        })
      }

      // 4. Integridad: el payload enviado debe ser idéntico al construido desde las fuentes.
      if (!p.aprobacion) return falla("No hay correo de aprobación.")
      const canonico = construirOrden(paquete, validacion, p.maestros, p.aprobacion)
      if ("error" in canonico) return falla(canonico.error)
      if (!args.payload) return falla("Falta el payload. Llame primero a oc_construir_payload y envíe la orden sin modificar.")
      if (!mismasOrdenes(args.payload, canonico.orden)) {
        await registrarControl(ctx.directory, { ...fila, resultado: "bloqueado", numero_oc: "", bloqueos: ["PAYLOAD_ALTERADO"] })
        return falla("El payload enviado no coincide con el construido desde las fuentes. No se crea la OC.")
      }

      // 5. Creación: evidencia + OC con las excepciones firmadas por la sesión que confirmó.
      const evidencia = await escribirEvidencia(ctx.directory, args.caso, p.aprobacion)
      const orden = {
        ...canonico.orden,
        excepciones: canonico.orden.excepciones.map((e) => ({ ...e, confirmado_por: `analista (sesión ${ctx.sessionId})` })),
      }
      const creada = await sap.crearOrden(orden)
      await registrarControl(ctx.directory, { ...fila, resultado: "exitoso", numero_oc: creada.numero_oc })
      return ok({
        numero_oc: creada.numero_oc,
        fecha: creada.fecha,
        idempotente: false,
        retroactiva: validacion.retroactiva,
        evidencia: evidencia.ruta,
        evidencia_pdf: evidencia.ruta_pdf,
      })
    })
  },
}
