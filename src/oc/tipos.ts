// Esquemas zod y tipos del dominio de órdenes de compra (PRD secciones 7.1, 7.2 y 7.4).
import { z } from "zod/v4"

// ---------- Fixtures de entrada (7.1) ----------

export const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string().optional(),
  adjuntos: z.array(z.string()).optional(),
})

export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number({ error: "cantidad debe ser numérica" }).positive(),
  valor_unitario: z.number({ error: "valor_unitario debe ser numérico" }).nonnegative(),
  valor_total: z.number({ error: "valor_total debe ser numérico" }).positive(),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha_solicitud debe tener formato AAAA-MM-DD"),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export const AprobacionArchivoSchema = z.object({
  de: z.string(),
  para: z.string().optional(),
  cc: z.array(z.string()).optional(),
  fecha: z.string(),
  asunto: z.string().optional(),
  cuerpo: z.string(),
})
export type AprobacionArchivo = z.infer<typeof AprobacionArchivoSchema>

// ---------- Maestros (7.1) ----------

export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})
export type Proveedor = z.infer<typeof ProveedorSchema>

export const AprobadorSchema = z.object({
  email: z.string(),
  nombre: z.string().optional(),
  tope: z.number(),
})
export type Aprobador = z.infer<typeof AprobadorSchema>

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string().optional(),
  subareas: z.array(z.string()),
  aprobadores: z.array(AprobadorSchema),
})
export type CentroCosto = z.infer<typeof CentroCostoSchema>

export const IndicadorIvaSchema = z.object({ codigo: z.string(), descripcion: z.string(), tasa: z.number() })
export const CondicionPagoSchema = z.object({ codigo: z.string(), descripcion: z.string(), dias: z.number() })

export type Maestros = {
  proveedores: Proveedor[]
  centros: CentroCosto[]
  indicadoresIva: z.infer<typeof IndicadorIvaSchema>[]
  condicionesPago: z.infer<typeof CondicionPagoSchema>[]
}

// ---------- Paquete normalizado (7.2) ----------

export const PaqueteSchema = z.object({
  correo: z.object({ id: z.string(), de: z.string(), asunto: z.string(), fecha: z.string() }),
  solicitud: SolicitudSchema,
  cotizacion: z
    .object({
      proveedor: z.string(),
      nit: z.string().nullable(),
      total: z.number(),
      moneda: z.string(),
      validez_hasta: z.string().nullable(),
      texto: z.string(),
      referencia: z.string().nullable(),
      fecha: z.string().nullable(),
    })
    .nullable(),
  aprobacion: z
    .object({ de: z.string(), fecha: z.string(), aprobado: z.boolean(), texto: z.string() })
    .nullable(),
  factura: z.object({ numero: z.string(), fecha: z.string(), total: z.number() }).nullable(),
  faltantes: z.array(z.string()),
})
export type Paquete = z.infer<typeof PaqueteSchema>

// ---------- Resultado de validación (HU-2) ----------

export type Hallazgo = {
  regla: string
  codigo: string
  detalle: string
  accion_sugerida: string
  valores?: Record<string, string | number>
}

export type Derivado = { valor: string; fuente: string; requiere_confirmacion: boolean }

export type Validacion = {
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: { indicador_iva?: Derivado; condiciones_pago?: Derivado }
  retroactiva: boolean
}

// ---------- Orden de compra (7.4) ----------

export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({
    email: z.string(),
    fecha_aprobacion: z.string(),
    evidencia_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int(),
        descripcion: z.string().max(40),
        cantidad: z.number(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(
    z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() }),
  ),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

// ---------- Contrato de herramientas (6.2) ----------

export type ContextoHerramienta = { directory: string; sessionId: string }

export type ResultadoOk<T> = { ok: true; data: T }
export type ResultadoError = { ok: false; error: string; detalle?: Record<string, unknown> }
export type Resultado<T> = ResultadoOk<T> | ResultadoError
