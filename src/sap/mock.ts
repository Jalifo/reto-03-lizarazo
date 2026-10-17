// SAP simulado sobre archivos: out/sap/ordenes.jsonl. Números secuenciales desde 4500000001.
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import type { SapAdapter } from "./adapter"
import type { OrdenCompra } from "../oc/tipos"
import { cargarMaestros } from "../oc/fuentes"
import { normalizarNit } from "../oc/texto"

const PRIMER_NUMERO = 4500000001

type Registro = { numero_oc: string; fecha: string; orden: OrdenCompra }

// Serializa las escrituras dentro del proceso para que dos peticiones simultáneas
// no obtengan el mismo número de OC.
let cola: Promise<unknown> = Promise.resolve()
function enSerie<T>(tarea: () => Promise<T>): Promise<T> {
  const siguiente = cola.then(tarea, tarea)
  cola = siguiente.catch(() => undefined)
  return siguiente
}

export class SapMock implements SapAdapter {
  private readonly archivo: string

  constructor(private readonly directorio: string) {
    this.archivo = path.join(directorio, "out", "sap", "ordenes.jsonl")
  }

  private async leer(): Promise<Registro[]> {
    if (!existsSync(this.archivo)) return []
    const texto = await readFile(this.archivo, "utf8")
    return texto
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Registro)
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const maestros = await cargarMaestros(this.directorio)
    if (!maestros.ok) return null
    const p = maestros.data.proveedores.find((x) => normalizarNit(x.nit) === normalizarNit(nit))
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const r = (await this.leer()).find((x) => x.orden.referencia.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc } : null
  }

  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    return enSerie(async () => {
      const registros = await this.leer()
      const existente = registros.find((x) => x.orden.referencia.solicitud_id === orden.referencia.solicitud_id)
      if (existente) return { numero_oc: existente.numero_oc, fecha: existente.fecha }
      const registro: Registro = {
        numero_oc: String(PRIMER_NUMERO + registros.length),
        fecha: new Date().toISOString(),
        orden,
      }
      await mkdir(path.dirname(this.archivo), { recursive: true })
      await appendFile(this.archivo, JSON.stringify(registro) + "\n", "utf8")
      return { numero_oc: registro.numero_oc, fecha: registro.fecha }
    })
  }
}
