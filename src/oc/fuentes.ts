// Lectura de fixtures y maestros. Los documentos son DATOS no confiables:
// solo se extraen campos con expresiones regulares; su texto nunca se interpreta como instrucción.
import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { z } from "zod/v4"
import {
  AprobacionArchivoSchema,
  CentroCostoSchema,
  CondicionPagoSchema,
  CorreoSchema,
  IndicadorIvaSchema,
  ProveedorSchema,
  SolicitudSchema,
  type AprobacionArchivo,
  type Maestros,
  type Paquete,
  type Resultado,
} from "./tipos"
import { campo, normalizarNit, parsearMonto, soloFecha, sumarDias } from "./texto"

const CASO_VALIDO = /^[a-z0-9][a-z0-9-]{0,63}$/

export function rutaCaso(directorio: string, caso: string): string | null {
  // Evita path traversal: el caso solo puede ser un nombre de carpeta simple.
  if (!CASO_VALIDO.test(caso)) return null
  return path.join(directorio, "fixtures", "reto-03", "solicitudes", caso)
}

async function leerJson(ruta: string): Promise<Resultado<unknown>> {
  try {
    return { ok: true, data: JSON.parse(await readFile(ruta, "utf8")) }
  } catch (e) {
    const motivo = e instanceof SyntaxError ? "JSON malformado" : "no se pudo leer"
    return { ok: false, error: `${path.basename(ruta)}: ${motivo}` }
  }
}

function errorZod(archivo: string, error: z.ZodError): string {
  const detalle = error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
  return `${archivo} no cumple el formato esperado (${detalle})`
}

async function leerMaestro<T>(base: string, nombre: string, esquema: z.ZodType<T>): Promise<Resultado<T>> {
  const crudo = await leerJson(path.join(base, nombre))
  if (!crudo.ok) return crudo
  const r = esquema.safeParse(crudo.data)
  return r.success ? { ok: true, data: r.data } : { ok: false, error: errorZod(nombre, r.error) }
}

export async function cargarMaestros(directorio: string): Promise<Resultado<Maestros>> {
  const base = path.join(directorio, "fixtures", "reto-03", "maestros")
  const proveedores = await leerMaestro(base, "proveedores.json", z.array(ProveedorSchema))
  if (!proveedores.ok) return proveedores
  const centros = await leerMaestro(base, "centros-costo.json", z.array(CentroCostoSchema))
  if (!centros.ok) return centros
  const iva = await leerMaestro(base, "indicadores-iva.json", z.array(IndicadorIvaSchema))
  if (!iva.ok) return iva
  const pago = await leerMaestro(base, "condiciones-pago.json", z.array(CondicionPagoSchema))
  if (!pago.ok) return pago
  return {
    ok: true,
    data: { proveedores: proveedores.data, centros: centros.data, indicadoresIva: iva.data, condicionesPago: pago.data },
  }
}

export function parsearCotizacion(texto: string): NonNullable<Paquete["cotizacion"]> {
  const totalLinea = texto.split(/\r?\n/).find((l) => /^\s*TOTAL\b/i.test(l)) ?? ""
  const fecha = campo(texto, /^\s*Fecha:\s*(\d{4}-\d{2}-\d{2})/i)
  const validezDias = campo(texto, /^\s*Validez[^:]*:\s*(\d+)\s*d[ií]as/i)
  const nit = campo(texto, /^\s*NIT:\s*([\d.\-]+)/i)
  return {
    proveedor: campo(texto, /^\s*Proveedor:\s*(.+)$/i) ?? "",
    nit: nit ? normalizarNit(nit) : null,
    total: parsearMonto(totalLinea.split(":").slice(1).join(":")) ?? 0,
    moneda: /USD/i.test(totalLinea) ? "USD" : "COP",
    validez_hasta: fecha && validezDias ? sumarDias(fecha, Number(validezDias)) : null,
    texto,
    referencia: campo(texto, /^\s*COTIZACI[OÓ]N\s+(\S+)/i),
    fecha,
  }
}

export function parsearFactura(texto: string): NonNullable<Paquete["factura"]> {
  const totalLinea = texto.split(/\r?\n/).find((l) => /^\s*TOTAL\b/i.test(l)) ?? ""
  return {
    numero: campo(texto, /No\.\s*(\S+)/i) ?? "sin número",
    fecha: campo(texto, /^\s*Fecha de emisi[oó]n:\s*(\d{4}-\d{2}-\d{2})/i) ?? "",
    total: parsearMonto(totalLinea.split(":").slice(1).join(":")) ?? 0,
  }
}

/** "Aprobado" presente y no negado ("no aprobado"). */
export function contieneAprobado(cuerpo: string): boolean {
  if (/\bno\s+(est[aá]\s+)?aprobad[oa]\b/i.test(cuerpo)) return false
  return /\baprobad[oa]\b/i.test(cuerpo)
}

async function leerTextoOpcional(ruta: string): Promise<string | null> {
  return existsSync(ruta) ? readFile(ruta, "utf8") : null
}

export async function leerAprobacionArchivo(dirCaso: string): Promise<AprobacionArchivo | null> {
  const ruta = path.join(dirCaso, "aprobacion.json")
  if (!existsSync(ruta)) return null
  const crudo = await leerJson(ruta)
  if (!crudo.ok) return null
  const r = AprobacionArchivoSchema.safeParse(crudo.data)
  return r.success ? r.data : null
}

/** HU-1: lee y normaliza el paquete. Un adjunto ausente queda en null y se lista en `faltantes`. */
export async function leerPaquete(directorio: string, caso: string): Promise<Resultado<Paquete>> {
  const dir = rutaCaso(directorio, caso)
  if (!dir) return { ok: false, error: `Nombre de caso inválido: "${caso}". Use el nombre de la carpeta, ej. sol-001.` }
  if (!existsSync(dir)) return { ok: false, error: `No existe el caso "${caso}" en fixtures/reto-03/solicitudes/.` }

  const faltantes: string[] = []

  const correoCrudo = await leerJson(path.join(dir, "correo.json"))
  if (!correoCrudo.ok) return { ok: false, error: `${correoCrudo.error}. Pida al solicitante reenviar el correo.` }
  const correo = CorreoSchema.safeParse(correoCrudo.data)
  if (!correo.success) return { ok: false, error: errorZod("correo.json", correo.error) }

  const solicitudCruda = await leerJson(path.join(dir, "solicitud.json"))
  if (!solicitudCruda.ok) {
    return { ok: false, error: `${solicitudCruda.error}. Pida al solicitante el Excel de solicitud.` }
  }
  const solicitud = SolicitudSchema.safeParse(solicitudCruda.data)
  if (!solicitud.success) {
    return { ok: false, error: `${errorZod("solicitud.json", solicitud.error)}. Pida al solicitante corregir el Excel.` }
  }

  const textoCotizacion = await leerTextoOpcional(path.join(dir, "cotizacion.txt"))
  if (textoCotizacion === null) faltantes.push("cotizacion.txt")

  const aprobacionArchivo = await leerAprobacionArchivo(dir)
  if (aprobacionArchivo === null) faltantes.push("aprobacion.json")

  const textoFactura = await leerTextoOpcional(path.join(dir, "factura.txt"))

  return {
    ok: true,
    data: {
      correo: { id: correo.data.id, de: correo.data.de, asunto: correo.data.asunto, fecha: correo.data.fecha },
      solicitud: solicitud.data,
      cotizacion: textoCotizacion === null ? null : parsearCotizacion(textoCotizacion),
      aprobacion:
        aprobacionArchivo === null
          ? null
          : {
              de: aprobacionArchivo.de,
              fecha: aprobacionArchivo.fecha,
              aprobado: contieneAprobado(aprobacionArchivo.cuerpo),
              texto: aprobacionArchivo.cuerpo,
            },
      factura: textoFactura === null ? null : parsearFactura(textoFactura),
      faltantes,
    },
  }
}

export { soloFecha }
