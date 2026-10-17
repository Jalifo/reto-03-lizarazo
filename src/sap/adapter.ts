// Interfaz obligatoria del adaptador SAP (PRD 7.4). El mock la implementa sobre archivos;
// la implementación real (OData/BAPI) se diseña en SOLUCION.md y no toca nada más del sistema.
import type { OrdenCompra } from "../oc/tipos"

export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>
}
