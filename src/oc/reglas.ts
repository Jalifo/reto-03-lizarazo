// Reglas de control RC1–RC10 (PRD 7.3). Código determinista: el modelo de lenguaje nunca decide
// si una regla se cumple. Cada regla es una función pura que recibe el paquete y los maestros.
import type { CentroCosto, Derivado, Hallazgo, Maestros, Paquete, Proveedor, Validacion } from "./tipos"
import { formatoCop, normalizarEmail, normalizarNit, normalizarNombre, soloFecha } from "./texto"

export const PARAMETROS = {
  toleranciaCotizacion: 0.02, // RC5: 2 %
  toleranciaAritmetica: 1, // RC10: ± 1 unidad monetaria
} as const

type Contexto = {
  paquete: Paquete
  maestros: Maestros
  proveedor: Proveedor | null
  centro: CentroCosto | null
}

type ResultadoRegla = {
  bloqueos?: Hallazgo[]
  confirmaciones?: Hallazgo[]
  derivados?: Validacion["derivados"]
  retroactiva?: boolean
}

export function buscarProveedor(paquete: Paquete, maestros: Maestros): Proveedor | null {
  const { proveedor_nit, proveedor_nombre } = paquete.solicitud
  if (proveedor_nit) {
    const nit = normalizarNit(proveedor_nit)
    return maestros.proveedores.find((p) => normalizarNit(p.nit) === nit) ?? null
  }
  const nombre = normalizarNombre(proveedor_nombre)
  return maestros.proveedores.find((p) => normalizarNombre(p.nombre) === nombre) ?? null
}

// RC1 · Proveedor existe (por NIT, o por nombre si no hay NIT) y está activo. Bloqueo.
function rc1({ paquete, proveedor }: Contexto): ResultadoRegla {
  const s = paquete.solicitud
  const criterio = s.proveedor_nit ? `NIT ${s.proveedor_nit}` : `nombre "${s.proveedor_nombre}"`
  if (!proveedor) {
    return {
      bloqueos: [
        {
          regla: "RC1",
          codigo: "PROVEEDOR_INEXISTENTE",
          detalle: `El proveedor ${s.proveedor_nombre} (${criterio}) no existe en el maestro de proveedores.`,
          accion_sugerida: "Solicitar la creación del proveedor en SAP (con RUT y documentos) o elegir un proveedor ya registrado.",
        },
      ],
    }
  }
  if (!proveedor.activo) {
    return {
      bloqueos: [
        {
          regla: "RC1",
          codigo: "PROVEEDOR_INACTIVO",
          detalle: `El proveedor ${proveedor.nombre} (código SAP ${proveedor.codigo_sap}) está inactivo.`,
          accion_sugerida: "Pedir a compras que revise y reactive el proveedor, o usar otro proveedor activo.",
        },
      ],
    }
  }
  return {}
}

// RC2 · Aprobación existe, dice "Aprobado" y viene de un aprobador del centro de costo. Bloqueo.
function rc2({ paquete, centro }: Contexto): ResultadoRegla {
  const a = paquete.aprobacion
  const cc = paquete.solicitud.centro_costo
  if (!a) {
    return {
      bloqueos: [
        {
          regla: "RC2",
          codigo: "APROBACION_AUSENTE",
          detalle: "El paquete no trae el correo de aprobación.",
          accion_sugerida: "Pedir al solicitante el correo de aprobación de su líder.",
        },
      ],
    }
  }
  const bloqueos: Hallazgo[] = []
  if (!a.aprobado) {
    bloqueos.push({
      regla: "RC2",
      codigo: "APROBACION_SIN_TEXTO",
      detalle: `El correo de aprobación de ${a.de} no contiene la palabra "Aprobado".`,
      accion_sugerida: "Pedir al líder una respuesta explícita con \"Aprobado\".",
    })
  }
  if (!centro) return { bloqueos }
  const autorizado = centro.aprobadores.some((ap) => normalizarEmail(ap.email) === normalizarEmail(a.de))
  if (!autorizado) {
    const validos = centro.aprobadores.map((ap) => `${ap.email} (tope ${formatoCop(ap.tope)})`).join(", ")
    const topeMaximo = Math.max(...centro.aprobadores.map((ap) => ap.tope))
    const cubre = paquete.solicitud.valor_total <= topeMaximo
    bloqueos.push({
      regla: "RC2",
      codigo: "APROBADOR_NO_AUTORIZADO",
      detalle: `${a.de} no es aprobador del centro de costo ${cc}. Aprobadores válidos: ${validos}.`,
      accion_sugerida: cubre
        ? `Solicitar la aprobación a un aprobador válido de ${cc} cuyo tope cubra ${formatoCop(paquete.solicitud.valor_total)}.`
        : `Ningún aprobador de ${cc} tiene tope suficiente para ${formatoCop(paquete.solicitud.valor_total)} (tope máximo ${formatoCop(topeMaximo)}): escalar a la instancia superior o revisar el centro de costo imputado.`,
      valores: { aprobador: a.de, centro_costo: cc, tope_maximo_centro: topeMaximo },
    })
  }
  return { bloqueos }
}

// RC3 · valor_total ≤ tope del aprobador para ese centro. Bloqueo.
// Si el aprobador no pertenece al centro, RC2 ya bloquea y aquí no hay tope que comparar.
function rc3({ paquete, centro }: Contexto): ResultadoRegla {
  const a = paquete.aprobacion
  if (!a || !centro) return {}
  const aprobador = centro.aprobadores.find((ap) => normalizarEmail(ap.email) === normalizarEmail(a.de))
  if (!aprobador) return {}
  const total = paquete.solicitud.valor_total
  if (total <= aprobador.tope) return {}
  return {
    bloqueos: [
      {
        regla: "RC3",
        codigo: "TOPE_EXCEDIDO",
        detalle: `El valor ${formatoCop(total)} supera el tope de ${aprobador.email} en ${centro.centro_costo} (${formatoCop(aprobador.tope)}).`,
        accion_sugerida: "Solicitar la aprobación a un aprobador del centro con tope suficiente.",
        valores: { valor_total: total, tope: aprobador.tope },
      },
    ],
  }
}

// RC4 · El centro de costo existe y la subárea le pertenece. Bloqueo.
function rc4({ paquete, centro }: Contexto): ResultadoRegla {
  const { centro_costo, subarea } = paquete.solicitud
  if (!centro) {
    return {
      bloqueos: [
        {
          regla: "RC4",
          codigo: "CENTRO_COSTO_INEXISTENTE",
          detalle: `El centro de costo ${centro_costo} no existe en el maestro.`,
          accion_sugerida: "Pedir al solicitante el centro de costo correcto.",
        },
      ],
    }
  }
  if (centro.subareas.includes(subarea)) return {}
  return {
    bloqueos: [
      {
        regla: "RC4",
        codigo: "SUBAREA_INVALIDA",
        detalle: `La subárea "${subarea}" no pertenece a ${centro_costo}. Subáreas válidas: ${centro.subareas.join(", ")}.`,
        accion_sugerida: "Pedir al solicitante la subárea correcta.",
      },
    ],
  }
}

// RC5 · |cotización − solicitud| / solicitud ≤ 2 %. Si excede o falta la cotización: confirmación.
function rc5({ paquete }: Contexto): ResultadoRegla {
  const s = paquete.solicitud
  const c = paquete.cotizacion
  if (!c) {
    return {
      confirmaciones: [
        {
          regla: "RC5",
          codigo: "COTIZACION_AUSENTE",
          detalle: "El paquete no trae cotización; no se puede contrastar el valor solicitado.",
          accion_sugerida: "Confirmar que se crea la OC sin cotización, o pedirla al solicitante.",
        },
      ],
    }
  }
  const diferencia = Math.abs(c.total - s.valor_total) / s.valor_total
  if (diferencia <= PARAMETROS.toleranciaCotizacion) return {}
  const pct = Math.round(diferencia * 10000) / 100
  return {
    confirmaciones: [
      {
        regla: "RC5",
        codigo: "DIFERENCIA_COTIZACION",
        detalle: `La cotización (${formatoCop(c.total)}) difiere ${pct} % de la solicitud (${formatoCop(s.valor_total)}); la tolerancia es 2 %.`,
        accion_sugerida:
          "Confirmar si se crea la OC por el valor de la solicitud (el aprobado) o devolver al solicitante para actualizar la solicitud y la aprobación.",
        valores: { valor_solicitud: s.valor_total, valor_cotizacion: c.total, diferencia_pct: pct },
      },
    ],
  }
}

// RC6 · indicador_iva ausente → se deriva del proveedor y se pide confirmación.
function rc6({ paquete, proveedor }: Contexto): ResultadoRegla {
  if (paquete.solicitud.indicador_iva) return {}
  if (!proveedor) return {} // RC1 ya bloquea; no hay de dónde derivar.
  return {
    derivados: {
      indicador_iva: {
        valor: proveedor.indicador_iva_default,
        fuente: "maestro.proveedores.indicador_iva_default",
        requiere_confirmacion: true,
      },
    },
    confirmaciones: [
      {
        regla: "RC6",
        codigo: "IVA_DERIVADO",
        detalle: `La solicitud no informa indicador de IVA. Se propone ${proveedor.indicador_iva_default} (predeterminado del proveedor ${proveedor.nombre})`,
        accion_sugerida: `Confirmar el indicador ${proveedor.indicador_iva_default} o indicar el correcto.`,
        valores: { indicador_iva_propuesto: proveedor.indicador_iva_default },
      },
    ],
  }
}

// RC7 · condiciones_pago ausente → se deriva del proveedor. Solo se informa.
function rc7({ paquete, proveedor }: Contexto): ResultadoRegla {
  if (paquete.solicitud.condiciones_pago || !proveedor) return {}
  return {
    derivados: {
      condiciones_pago: {
        valor: proveedor.condiciones_pago_default,
        fuente: "maestro.proveedores.condiciones_pago_default",
        requiere_confirmacion: false,
      },
    },
  }
}

// RC8 · factura con fecha anterior a la solicitud → retroactiva. Confirmación y registro en control.
function rc8({ paquete }: Contexto): ResultadoRegla {
  const f = paquete.factura
  if (!f || !f.fecha || f.fecha >= paquete.solicitud.fecha_solicitud) return {}
  return {
    retroactiva: true,
    confirmaciones: [
      {
        regla: "RC8",
        codigo: "OC_RETROACTIVA",
        detalle: `La factura ${f.numero} es del ${f.fecha}, anterior a la solicitud (${paquete.solicitud.fecha_solicitud}): la compra se hizo antes de la OC.`,
        accion_sugerida: "Confirmar la creación como OC retroactiva; quedará marcada retroactiva = true en el log de control.",
        valores: { fecha_factura: f.fecha, fecha_solicitud: paquete.solicitud.fecha_solicitud },
      },
    ],
  }
}

// RC9 · fecha de aprobación ≥ fecha de solicitud. Si no: confirmación.
function rc9({ paquete }: Contexto): ResultadoRegla {
  const a = paquete.aprobacion
  if (!a) return {}
  const fechaAprobacion = soloFecha(a.fecha)
  if (fechaAprobacion >= paquete.solicitud.fecha_solicitud) return {}
  return {
    confirmaciones: [
      {
        regla: "RC9",
        codigo: "APROBACION_ANTERIOR",
        detalle: `La aprobación (${fechaAprobacion}) es anterior a la solicitud (${paquete.solicitud.fecha_solicitud}).`,
        accion_sugerida: "Confirmar que la aprobación corresponde a esta solicitud.",
      },
    ],
  }
}

// RC10 · cantidad × valor_unitario = valor_total (± 1). Bloqueo.
function rc10({ paquete }: Contexto): ResultadoRegla {
  const { cantidad, valor_unitario, valor_total } = paquete.solicitud
  const calculado = cantidad * valor_unitario
  if (Math.abs(calculado - valor_total) <= PARAMETROS.toleranciaAritmetica) return {}
  return {
    bloqueos: [
      {
        regla: "RC10",
        codigo: "TOTAL_INCONSISTENTE",
        detalle: `cantidad × valor unitario = ${formatoCop(calculado)}, pero el valor total de la solicitud es ${formatoCop(valor_total)}.`,
        accion_sugerida: "Pedir al solicitante corregir cantidades o valores del Excel.",
      },
    ],
  }
}

const REGLAS = [rc1, rc2, rc3, rc4, rc5, rc6, rc7, rc8, rc9, rc10]

/** HU-2: aplica TODAS las reglas (no se detiene en la primera) y consolida el resultado. */
export function validarPaquete(paquete: Paquete, maestros: Maestros): Validacion {
  const contexto: Contexto = {
    paquete,
    maestros,
    proveedor: buscarProveedor(paquete, maestros),
    centro: maestros.centros.find((c) => c.centro_costo === paquete.solicitud.centro_costo) ?? null,
  }
  const resultado: Validacion = { apta: true, bloqueos: [], confirmaciones: [], derivados: {}, retroactiva: false }
  for (const regla of REGLAS) {
    const r = regla(contexto)
    resultado.bloqueos.push(...(r.bloqueos ?? []))
    resultado.confirmaciones.push(...(r.confirmaciones ?? []))
    Object.assign(resultado.derivados, r.derivados ?? {})
    resultado.retroactiva ||= r.retroactiva ?? false
  }
  resultado.apta = resultado.bloqueos.length === 0
  return resultado
}

export type { Derivado }
