// HU-3: construcción del payload de la OC (7.4) con trazabilidad de cada valor a su fuente.
import type { AprobacionArchivo, Maestros, OrdenCompra, Paquete, Proveedor, Validacion } from "./tipos"
import { OrdenCompraSchema } from "./tipos"
import { buscarProveedor } from "./reglas"
import { contenidoEvidencia, sha256 } from "./evidencia"

export type Trazabilidad = Record<string, string>

/** Unidad SAP derivada del texto de la solicitud. Regla simple y explícita (ver SOLUCION.md, supuestos). */
export function derivarUnidad(descripcion: string): OrdenCompra["posiciones"][number]["unidad"] {
  if (/\bhoras?\b/i.test(descripcion)) return "H"
  if (/\bmensual(idad)?\b|\bpor mes\b/i.test(descripcion)) return "MES"
  return "UN"
}

export function construirOrden(
  paquete: Paquete,
  validacion: Validacion,
  maestros: Maestros,
  aprobacion: AprobacionArchivo,
): { orden: OrdenCompra; trazabilidad: Trazabilidad } | { error: string } {
  if (!validacion.apta) return { error: "La solicitud tiene bloqueos; no se construye el payload." }
  const proveedor: Proveedor | null = buscarProveedor(paquete, maestros)
  if (!proveedor) return { error: "Proveedor no encontrado en el maestro." }
  const s = paquete.solicitud

  const condicionesPago = s.condiciones_pago ?? validacion.derivados.condiciones_pago?.valor
  const indicadorIva = s.indicador_iva ?? validacion.derivados.indicador_iva?.valor
  if (!condicionesPago || !indicadorIva) return { error: "Faltan condiciones de pago o indicador de IVA y no se pudieron derivar." }

  const orden: OrdenCompra = {
    referencia: {
      solicitud_id: s.solicitud_id,
      correo_id: paquete.correo.id,
      cotizacion_ref: paquete.cotizacion?.referencia ?? null,
    },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre },
    moneda: s.moneda,
    condiciones_pago: condicionesPago,
    aprobador: {
      email: aprobacion.de,
      fecha_aprobacion: aprobacion.fecha,
      evidencia_sha256: sha256(contenidoEvidencia(aprobacion)),
    },
    posiciones: [
      {
        numero: 10,
        descripcion: s.descripcion.slice(0, 40).trim(),
        cantidad: s.cantidad,
        unidad: derivarUnidad(s.descripcion),
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: indicadorIva,
      },
    ],
    excepciones: validacion.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: null })),
  }

  const trazabilidad: Trazabilidad = {
    "referencia.solicitud_id": "solicitud.solicitud_id",
    "referencia.correo_id": "correo.id",
    "referencia.cotizacion_ref": paquete.cotizacion ? "cotizacion (encabezado COTIZACIÓN)" : "sin cotización",
    sociedad: "constante del PRD 7.4",
    organizacion_compras: "constante del PRD 7.4",
    "proveedor.codigo_sap": "maestro.proveedores",
    "proveedor.nit": "maestro.proveedores",
    "proveedor.nombre": "maestro.proveedores",
    moneda: "solicitud.moneda",
    condiciones_pago: s.condiciones_pago ? "solicitud.condiciones_pago" : "derivado: maestro.proveedores.condiciones_pago_default (RC7)",
    "aprobador.email": "aprobacion.de",
    "aprobador.fecha_aprobacion": "aprobacion.fecha",
    "aprobador.evidencia_sha256": "derivado: sha256 del contenido de out/<caso>/aprobacion.txt",
    "posiciones[0].numero": "constante (primera posición SAP = 10)",
    "posiciones[0].descripcion": "solicitud.descripcion (truncada a 40 caracteres)",
    "posiciones[0].cantidad": "solicitud.cantidad",
    "posiciones[0].unidad": "derivado: texto de solicitud.descripcion (horas → H, mensual → MES, otro → UN)",
    "posiciones[0].precio_unitario": "solicitud.valor_unitario",
    "posiciones[0].centro_costo": "solicitud.centro_costo",
    "posiciones[0].subarea": "solicitud.subarea",
    "posiciones[0].indicador_iva": s.indicador_iva ? "solicitud.indicador_iva" : "derivado: maestro.proveedores.indicador_iva_default (RC6)",
    excepciones: "oc_validar (confirmaciones)",
  }

  return { orden: OrdenCompraSchema.parse(orden), trazabilidad }
}

/** Compara dos órdenes ignorando quién confirmó las excepciones. Detecta payloads alterados. */
export function mismasOrdenes(a: OrdenCompra, b: OrdenCompra): boolean {
  const limpiar = (o: OrdenCompra) =>
    ordenarClaves({ ...o, excepciones: o.excepciones.map((e) => ({ codigo: e.codigo, detalle: e.detalle })) })
  return JSON.stringify(limpiar(a)) === JSON.stringify(limpiar(b))
}

function ordenarClaves(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(ordenarClaves)
  if (valor !== null && typeof valor === "object") {
    const entradas = Object.entries(valor as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y))
    return Object.fromEntries(entradas.map(([k, v]) => [k, ordenarClaves(v)]))
  }
  return valor
}
