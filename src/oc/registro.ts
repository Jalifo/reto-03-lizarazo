// Registros de auditoría en out/: control.csv (HU-5) y log.jsonl (CA4).
import { appendFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"

export type FilaControl = {
  solicitud_id: string
  resultado: "exitoso" | "existente" | "bloqueado" | "pendiente"
  numero_oc: string
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
}

const ENCABEZADO = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n"

function celda(valor: string): string {
  return /[",\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor
}

export async function registrarControl(directorio: string, fila: FilaControl): Promise<void> {
  const ruta = path.join(directorio, "out", "control.csv")
  await mkdir(path.dirname(ruta), { recursive: true })
  if (!existsSync(ruta)) await appendFile(ruta, ENCABEZADO, "utf8")
  const linea = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc,
    String(fila.retroactiva),
    fila.bloqueos.join("|"),
    fila.confirmaciones.join("|"),
    new Date().toISOString(),
  ]
    .map(celda)
    .join(",")
  await appendFile(ruta, linea + "\n", "utf8")
}

export async function registrarLog(directorio: string, evento: Record<string, unknown>): Promise<void> {
  const ruta = path.join(directorio, "out", "log.jsonl")
  await mkdir(path.dirname(ruta), { recursive: true })
  await appendFile(ruta, JSON.stringify({ ts: new Date().toISOString(), ...evento }) + "\n", "utf8")
}
